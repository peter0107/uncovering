import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { CheckCircle2, Clock, Info, Send, X, MessageCircle } from "lucide-react";
import { RichTextContent, RichTextEditor } from "@/components/RichTextEditor";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { SimulationShell, MaterialTabStrip, MaterialBody } from "@/components/SimulationShell";
import { cn } from "@/lib/utils";
import { capturePostHogEvent, consumeSimulationEntry } from "@/lib/posthog";
import { useAuth } from "@/hooks/use-auth";
import { AUTHENTICATION_ENABLED } from "@/lib/auth-features";
import { supabase } from "@/integrations/supabase/client";
import { chatWithSimulationAssistant } from "@/lib/ai-chat.functions";
import { toast } from "sonner";
import {
  allAnswered,
  buildResponseJson,
  buildResponseText,
  buildSidebarMaterialTabs,
  buildWizardModel,
  getPlainAnswerText,
  getStepMaterialContext,
  stepAnswered,
  wrapSingleAsModel,
  type MaterialTab,
  type WizardModel,
} from "@/lib/simulation-steps";
import { getAdminSimulationPreview } from "@/lib/simulations.functions";

export const Route = createFileRoute("/simulation/$id")({
  head: () => ({ meta: [{ title: "시뮬레이션 — Beginner" }] }),
  validateSearch: z.object({
    preview: z
      .union([z.literal("1"), z.literal(1), z.literal(true)])
      .optional()
      .transform((v) => (v == null ? undefined : ("1" as const))),
    // demo=1: 랜딩에서 넘어온 방문자용 공개 열람. 로그인 여부와 무관하게 항상 미리보기로
    // 취급 — 작성은 되고 제출만 막는다. preview=1(관리자 전용)과 달리 공개 데이터만
    // 읽으므로 별도 권한이 필요 없다.
    demo: z
      .union([z.literal("1"), z.literal(1), z.literal(true)])
      .optional()
      .transform((v) => (v == null ? undefined : ("1" as const))),
  }),
  component: SimulationDetailPage,
});

type SimulationDetail = {
  id: string;
  title: string;
  simulation_source: "company" | "expert";
  expert_nickname: string | null;
  expert_job_title: string | null;
  simulation_format: "single" | "selection";
  selection_mode: "separated" | "common";
  single_answer_question: string | null;
  task_prompt: string | null;
  shared_situation: string | null;
  shared_materials: string | null;
  steps: unknown;
  estimated_minutes: number | null;
  role_label: string | null;
  company_name: string;
  company_is_partner: boolean;
};

const CHIP_JAPAN_CONTENT_MARKETER_VIDEO = "/videos/chip-japan-content-marketer.mp4";

function isChipJapanContentMarketerSimulation(simulation: SimulationDetail) {
  const searchableText = [
    simulation.title,
    simulation.company_name,
    simulation.role_label ?? "",
    simulation.expert_job_title ?? "",
  ]
    .join(" ")
    .toLowerCase();

  return ["chip", "일본", "콘텐츠", "마케터"].every((keyword) => searchableText.includes(keyword));
}

const MAX_ANSWER_LENGTH = 1000;

// 제출 시 난이도 자기평가 5단계 (DB에는 1~5 정수로 저장)
const DIFFICULTY_OPTIONS = [
  { value: 1, label: "매우 쉬웠어요" },
  { value: 2, label: "쉬웠어요" },
  { value: 3, label: "적당했어요" },
  { value: 4, label: "어려웠어요" },
  { value: 5, label: "매우 어려웠어요" },
] as const;
// 화면 배열 — 위저드 모델(steps)에서 파생. intro/submit은 model.steps 밖의 고정 화면.
type Screen =
  | { kind: "intro" }
  | { kind: "situation"; stepIndex: number; markdown: string }
  | { kind: "materials"; stepIndex: number; tabs: MaterialTab[] }
  | { kind: "question"; stepIndex: number; promptIndex: number }
  | { kind: "submit" };

function buildScreens(model: WizardModel): Screen[] {
  const screens: Screen[] = [{ kind: "intro" }];
  let last: { situation?: string; materials?: string } = {};

  model.steps.forEach((step, stepIndex) => {
    const ctx = getStepMaterialContext(model, step);
    if (ctx.situation && ctx.situation !== last.situation) {
      screens.push({ kind: "situation", stepIndex, markdown: ctx.situation });
    }
    if (ctx.materials && ctx.materials !== last.materials) {
      const tabs = buildSidebarMaterialTabs({ materials: ctx.materials });
      if (tabs.length > 0) screens.push({ kind: "materials", stepIndex, tabs });
    }
    last = ctx;
    step.prompts.forEach((_, promptIndex) => {
      screens.push({ kind: "question", stepIndex, promptIndex });
    });
  });

  screens.push({ kind: "submit" });
  return screens;
}

/** 화면이 속한 상단 진행도(1-indexed). intro는 1단계, submit은 마지막 단계로 계산. */
function screenProgressStep(screen: Screen, totalSteps: number): number {
  if (screen.kind === "intro") return 1;
  if (screen.kind === "submit") return totalSteps;
  return screen.stepIndex + 1;
}

function AnswerEditor({
  id,
  value,
  onChange,
  className = "",
  containerClassName = "",
  ariaLabelledby,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
  containerClassName?: string;
  ariaLabelledby?: string;
}) {
  return (
    <div className={`min-h-0 ${containerClassName} ${className}`}>
      <RichTextEditor
        id={id}
        ariaLabelledby={ariaLabelledby}
        label=""
        value={value}
        onChange={onChange}
        placeholder="여기에 답안을 작성해주세요"
        minHeight="16rem"
        maxLength={MAX_ANSWER_LENGTH}
      />
    </div>
  );
}

function TrialDemoSimulation() {
  const [answer, setAnswer] = useState("");
  const [showResult, setShowResult] = useState(false);

  return (
    <div className="min-h-dvh bg-white text-[#16233D]">
      <header className="sticky top-0 z-10 flex h-[68px] items-center justify-between border-b border-[#EEF0F4] bg-white/95 px-5 backdrop-blur sm:px-10">
        <Link to="/lp/trial" className="text-xl leading-none text-[#5A6478]" aria-label="랜딩으로 돌아가기">←</Link>
        <span className="text-[15px] font-bold">서비스 기획자 체험</span>
        <span className="text-sm text-[#9BA3B2]">1 / 3</span>
      </header>

      <main>
        <section className="mx-auto max-w-[760px] px-5 pb-10 pt-[72px]">
          <p className="text-sm font-bold text-[#2E86FF]">STEP 1 · 상황 파악</p>
          <h1 className="mt-3 text-4xl font-extrabold leading-[1.35] tracking-[-1.4px]">구독 서비스 가입 전환율 개선</h1>
          <p className="mt-3 text-[17px] leading-[1.75] text-[#5A6478]">신규 구독 서비스의 가입 전환율이 3주째 떨어지고 있습니다. 원인을 찾고 개선안을 제안해주세요.</p>
        </section>

        <section className="mx-auto max-w-[760px] px-5 pb-12">
          <p className="text-sm font-bold text-[#5A6478]">참고 자료</p>
          <div className="mt-3 rounded-[20px] bg-[#F7F8FA] p-7">
            <b className="text-[15px]">주차별 가입 퍼널</b>
            <div className="mt-4 space-y-3 text-[14.5px] text-[#5A6478]">
              {[["랜딩 방문", "100%", "12,400", "#1E3A66"], ["가입 시작", "46%", "5,700", "#1E3A66"], ["정보 입력", "19%", "2,350", "#2E86FF"], ["첫 결제", "7%", "860", "#2E86FF"]].map(([label, width, value, color]) => (
                <div key={label} className="flex items-center gap-3">
                  <span className="w-20 shrink-0">{label}</span>
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-[#DCE4F0]"><i className="block h-full rounded-full" style={{ width, backgroundColor: color }} /></span>
                  <b className="w-14 text-right text-[#16233D]">{value}</b>
                </div>
              ))}
            </div>
            <div className="mt-5 flex flex-wrap gap-x-10 gap-y-2 border-t border-[#E4E7ED] pt-4 text-sm text-[#5A6478]">
              <span>검색 유입 전환율 <b className="ml-2 text-[#16233D]">7.4% → 7.1%</b></span>
              <span>SNS 광고 유입 전환율 <b className="ml-2 text-[#2E86FF]">6.9% → 2.2%</b></span>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-[760px] px-5 pb-14">
          <p className="text-sm font-bold text-[#2E86FF]">STEP 2 · 답안 작성</p>
          <h2 className="mt-3 text-[22px] font-extrabold tracking-[-.7px]">어디가 문제이고, 무엇을 개선하시겠어요?</h2>
          <Textarea value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="문제라고 생각한 구간과 그 근거, 제안하는 개선안을 3~5줄로 적어보세요." className="mt-4 min-h-36 resize-none rounded-[20px] border-0 bg-[#F7F8FA] p-6 text-base leading-7 shadow-none focus-visible:ring-2 focus-visible:ring-[#2E86FF]" />
          <p className="mt-3 text-[13.5px] text-[#9BA3B2]">평균 작성 시간 4분 · 중간 저장돼요</p>
          <button type="button" onClick={() => setShowResult(true)} className="mt-5 w-full rounded-[14px] bg-[#1E3A66] py-4 text-[17px] font-bold text-white hover:bg-[#16233D]">답안 비교 보기</button>
        </section>

        {showResult && (
          <section className="bg-[#F7F8FA] px-5 py-16">
            <div className="mx-auto flex max-w-[760px] flex-col gap-6">
              <div><p className="text-sm font-bold text-[#2E86FF]">STEP 3 · 답안 비교</p><h2 className="mt-3 text-3xl font-extrabold tracking-[-1.2px]">모범 답안과 현직자 피드백까지</h2><p className="mt-2 text-[16.5px] leading-7 text-[#5A6478]">제출하면 바로 이렇게 보여드려요.</p></div>
              <DemoAnswer label="내가 낸 답안" text={answer.trim() || "가입 화면 이탈률이 높아 보여서, 입력 항목을 줄이는 걸 제안했어요."} />
              <DemoAnswer blue label="현직자 모범답안" text="이탈률보다 먼저 유입 채널별 코호트를 나눠 봅니다. SNS 광고 유입만 6.9%에서 2.2%로 떨어졌다면 화면이 아니라 타깃과 소재 문제예요. 화면을 고치기 전에 광고 소재와 랜딩의 약속이 어긋난 지점을 먼저 맞춥니다." />
              <DemoAnswer label="현직자 피드백" text="문제를 화면에서만 찾은 점이 아쉬워요. 자료에 채널별 수치가 있었으니, 원인을 나누는 기준부터 잡아보면 훨씬 좋아집니다." />
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

function DemoAnswer({ label, text, blue = false }: { label: string; text: string; blue?: boolean }) {
  return <div><p className={`mb-2 text-[13px] font-bold ${blue ? "text-[#2E86FF]" : "text-[#9BA3B2]"}`}>{label}</p><div className={`rounded-2xl p-5 text-base leading-7 text-[#5A6478] ${blue ? "bg-[#EAF2FF]" : "bg-white"}`}>{text}</div></div>;
}
function SimulationDetailPage() {
  const { id } = Route.useParams();
  const { preview, demo } = Route.useSearch();
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const isPreview = preview === "1";
  // 로그인 여부와 무관하게 항상 미리보기로 취급 — 이미 로그인한 방문자가 데모 링크로
  // 들어와도 실제 제출·이탈 설문 대상이 되면 안 된다.
  const isDemo = demo === "1" || demo === '"1"';
  // 로그인 리다이렉트·로딩 가드에서 preview와 demo를 같이 통과시킨다.
  const isOpenView = isPreview || isDemo;
  const [accessReady, setAccessReady] = useState(isOpenView);

  const [sim, setSim] = useState<SimulationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [screenIdx, setScreenIdx] = useState(0);
  const [materialTabIdx, setMaterialTabIdx] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [hintOpen, setHintOpen] = useState(false);
  const [consent, setConsent] = useState<boolean | null>(null);
  const [difficultyRating, setDifficultyRating] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submittedAt, setSubmittedAt] = useState<Date | null>(null);
  const [submittedSubmissionId, setSubmittedSubmissionId] = useState<string | null>(null);
  const [startedAt] = useState(() => new Date());
  const startCapturedRef = useRef<string | null>(null);

  // AI 어시스트 대화 (제출 시 함께 저장돼 기업 담당자 화면에도 노출됨)
  // ponytail: 새 화면 셸에서는 버튼을 숨김 — 되살리려면 아래 {aiPanel}을 렌더에 추가
  type ChatMessage = { role: "user" | "assistant"; content: string; at: string };
  const [chatOpen, setChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatSending, setChatSending] = useState(false);

  const sendChat = async () => {
    const text = chatInput.trim();
    if (!text || chatSending) return;
    const now = new Date().toISOString();
    const userMsg: ChatMessage = { role: "user", content: text, at: now };
    const history = [...chatMessages, userMsg];
    setChatMessages(history);
    setChatInput("");
    setChatSending(true);
    try {
      const { reply } = await chatWithSimulationAssistant({
        data: {
          simulationId: id,
          messages: history.map(({ role, content }) => ({ role, content })),
        },
      });
      setChatMessages((prev) => [
        ...prev,
        { role: "assistant", content: reply, at: new Date().toISOString() },
      ]);
    } catch (error) {
      setChatMessages((prev) => prev.filter((m) => m !== userMsg));
      setChatInput(text);
      toast.error(
        error instanceof Error
          ? error.message
          : "AI 응답을 받지 못했어요. 잠시 후 다시 시도해 주세요.",
      );
    } finally {
      setChatSending(false);
    }
  };

  const wizardModel: WizardModel | null = useMemo(
    () =>
      sim?.simulation_format === "selection"
        ? buildWizardModel(sim.task_prompt, sim.steps, {
            selectionMode: sim.selection_mode,
            situation: sim.shared_situation,
            materials: sim.shared_materials,
          })
        : null,
    [
      sim?.simulation_format,
      sim?.task_prompt,
      sim?.steps,
      sim?.selection_mode,
      sim?.shared_situation,
      sim?.shared_materials,
    ],
  );
  // 저작 스텝이 없거나 형식이 깨진 경우(폴백 포함) 1단계짜리 모델로 감싸 같은 셸을 태운다.
  const isSingle = !wizardModel;
  const model: WizardModel | null = useMemo(
    () =>
      wizardModel ??
      (sim
        ? wrapSingleAsModel({
            taskPrompt: sim.task_prompt,
            singleAnswerQuestion: sim.single_answer_question,
          })
        : null),
    [wizardModel, sim],
  );
  const screens = useMemo(() => (model ? buildScreens(model) : []), [model]);
  const draftKey = `sim-draft-${id}`;

  useEffect(() => {
    if (authLoading) return;

    if (isOpenView || !AUTHENTICATION_ENABLED) {
      setAccessReady(true);
      return;
    }

    if (!user) {
      setAccessReady(true);
      return;
    }

    let active = true;
    setAccessReady(false);

    void supabase
      .from("job_seekers")
      .select("job_interests")
      .eq("id", user.id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!active) return;

        const hasJobInterests = Array.isArray(data?.job_interests) && data.job_interests.length > 0;
        if (!error && !hasJobInterests) {
          navigate({
            to: "/onboarding",
            search: { redirect: `/simulation/${id}` },
            replace: true,
          });
          return;
        }

        setAccessReady(true);
      });

    return () => {
      active = false;
    };
  }, [authLoading, id, isOpenView, navigate, user]);

  useEffect(() => {
    if (authLoading || !accessReady) return;

    async function loadSimulation() {
      try {
        if (isPreview) {
          const data = await getAdminSimulationPreview({ data: { id } });
          setSim({
            id: data.id,
            title: data.title,
            simulation_source: data.simulationSource,
            expert_nickname: data.expertNickname || null,
            expert_job_title: data.expertJobTitle || null,
            simulation_format: data.simulationFormat,
            selection_mode: data.selectionMode,
            single_answer_question: data.singleAnswerQuestion,
            task_prompt: data.taskPrompt,
            shared_situation: data.sharedSituation,
            shared_materials: data.sharedMaterials,
            steps: data.steps,
            estimated_minutes: data.estimatedMinutes,
            role_label: data.roleLabel || null,
            company_name: data.companyName,
            // 관리자 미리보기는 공식 흐름으로 표시(비공식 고지 없이 내용만 확인).
            company_is_partner: true,
          });
          return;
        }

        const { data } = await supabase
          .from("job_simulations")
          .select(
            "id, title, role_label, simulation_source, expert_nickname, expert_job_title, simulation_format, selection_mode, single_answer_question, task_prompt, shared_situation, shared_materials, steps, estimated_minutes, companies(name, is_partner)",
          )
          .eq("id", id)
          .eq("is_public", true)
          .is("deleted_at", null)
          .maybeSingle();

        if (!data) return;
        const row = data as unknown as {
          id: string;
          title: string;
          simulation_source: "company" | "expert" | null;
          expert_nickname: string | null;
          expert_job_title: string | null;
          simulation_format: "single" | "selection" | null;
          selection_mode: "separated" | "common" | null;
          single_answer_question: string | null;
          task_prompt: string | null;
          shared_situation: string | null;
          shared_materials: string | null;
          steps: unknown;
          estimated_minutes: number | null;
          role_label: string | null;
          companies: { name: string; is_partner: boolean | null } | null;
        };
        setSim({
          id: row.id,
          title: row.title,
          simulation_source: row.simulation_source === "expert" ? "expert" : "company",
          expert_nickname: row.expert_nickname,
          expert_job_title: row.expert_job_title,
          simulation_format: row.simulation_format === "selection" ? "selection" : "single",
          selection_mode: row.selection_mode === "common" ? "common" : "separated",
          single_answer_question: row.single_answer_question,
          task_prompt: row.task_prompt,
          shared_situation: row.shared_situation,
          shared_materials: row.shared_materials,
          steps: row.steps,
          estimated_minutes: row.estimated_minutes,
          role_label: row.role_label,
          company_name:
            row.simulation_source === "expert"
              ? row.expert_nickname || "현직자"
              : (row.companies?.name ?? ""),
          // 현직자 시뮬레이션은 공식/비공식 개념이 없으므로 고지 대상에서 제외(true).
          company_is_partner:
            row.simulation_source === "expert" ? true : (row.companies?.is_partner ?? false),
        });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "시뮬레이션을 불러오지 못했습니다.");
      } finally {
        setLoading(false);
      }
    }

    void loadSimulation();
  }, [accessReady, id, isPreview, isOpenView, user, authLoading]);

  // simulation_start는 카드 클릭이 아니라 상세 화면 실제 진입 시점에 찍는다.
  useEffect(() => {
    if (isPreview || !accessReady || !sim || (AUTHENTICATION_ENABLED && !user)) return;
    if (startCapturedRef.current === sim.id) return;
    startCapturedRef.current = sim.id;
    const entry = consumeSimulationEntry(sim.id) ?? "direct";
    void capturePostHogEvent(isDemo ? "trial_simulation_start" : "simulation_start", {
      simulation_id: sim.id,
      simulation_source: sim.simulation_source,
      simulation_context: isDemo ? "trial_preview" : "standard",
      entry,
    });
  }, [isPreview, accessReady, user, sim]);

  // 위저드 임시저장 복원 (이탈 방지)
  useEffect(() => {
    if (!model || screens.length === 0 || typeof window === "undefined" || isPreview) return;
    try {
      const raw = window.localStorage.getItem(draftKey);
      if (raw) {
        const saved = JSON.parse(raw) as {
          answers?: Record<string, string>;
          screenIdx?: number;
          stepIdx?: number;
        };
        if (saved.answers) setAnswers(saved.answers);
        if (typeof saved.screenIdx === "number") {
          setScreenIdx(Math.min(Math.max(saved.screenIdx, 0), screens.length - 1));
        } else if (typeof saved.stepIdx === "number") {
          const idx = screens.findIndex(
            (s) => s.kind === "question" && s.stepIndex === saved.stepIdx,
          );
          if (idx >= 0) setScreenIdx(idx);
        }
      }
    } catch {
      // 무시
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, draftKey, isPreview]);

  // 위저드 임시저장
  useEffect(() => {
    if (!model || typeof window === "undefined" || submittedAt || isPreview) return;
    try {
      window.localStorage.setItem(draftKey, JSON.stringify({ answers, screenIdx }));
    } catch {
      // 무시
    }
  }, [answers, screenIdx, model, draftKey, submittedAt, isPreview]);

  // 화면 전환 시 자료 탭/힌트/바텀시트 초기화
  useEffect(() => {
    setMaterialTabIdx(0);
    setDrawerOpen(false);
    setHintOpen(false);
  }, [screenIdx]);

  const setAnswer = (qid: string, value: string) =>
    setAnswers((prev) => ({ ...prev, [qid]: value }));

  const trackSimulationAction = (event: string, properties: Record<string, unknown> = {}) => {
    if (!sim || !model) return;
    const currentScreen = screens[screenIdx];
    void capturePostHogEvent(
      isDemo && event.startsWith("simulation_") ? `trial_${event}` : event,
      {
      simulation_id: sim.id,
      simulation_name: sim.title,
      simulation_source: sim.simulation_source,
      simulation_format: sim.simulation_format,
      simulation_context: isDemo ? "trial_preview" : "standard",
      screen_kind: currentScreen?.kind ?? "unknown",
      screen_index: screenIdx,
      step_index: currentScreen ? screenProgressStep(currentScreen, model.steps.length) : null,
      total_steps: model.steps.length,
      ...properties,
      },
    );
  };

  const goNext = () => {
    trackSimulationAction("simulation_next_clicked");
    setScreenIdx((i) => Math.min(i + 1, screens.length - 1));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const goPrev = () => {
    trackSimulationAction("simulation_previous_clicked");
    setScreenIdx((i) => Math.max(i - 1, 0));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleSubmit = async () => {
    if (!sim || !model) return;
    if (isPreview) {
      toast("미리보기에서는 답안을 제출할 수 없습니다.");
      return;
    }
    if (isDemo) {
      toast("체험판에서는 답안을 제출할 수 없어요. 체험을 신청하면 이용할 수 있어요.");
      return;
    }

    let response_text: string;
    let response_json: ReturnType<typeof buildResponseJson>;

    if (isSingle) {
      const text = getPlainAnswerText(answers.response ?? "");
      if (!text) {
        toast.error("답안을 작성해주세요.");
        return;
      }
      response_text = text;
      response_json = {
        format: "step_wizard_v1",
        answers: [{ id: "response", label: "답안", answer: (answers.response ?? "").trim() }],
      };
    } else {
      if (!allAnswered(model, answers)) {
        toast.error("모든 항목에 답변을 작성해주세요.");
        return;
      }
      response_text = buildResponseText(model, answers);
      response_json = buildResponseJson(model, answers);
    }

    if (difficultyRating === null) {
      toast.error("시뮬레이션 난이도를 평가해주세요.");
      return;
    }
    if (consent === null) {
      toast.error("답안 전송 동의 여부를 선택해주세요.");
      return;
    }
    if (!user) {
      if (AUTHENTICATION_ENABLED) {
        toast.error("제출하려면 로그인이 필요해요.");
        navigate({ to: "/login", search: { redirect: `/simulation/${id}` } });
      } else {
        toast.error("현재 답안 제출은 사용할 수 없습니다.");
      }
      return;
    }

    setSubmitting(true);
    const now = new Date();
    const { data: submission, error } = await supabase
      .from("submissions")
      .insert({
        job_seeker_id: user.id,
        job_simulation_id: sim.id,
        response_text,
        started_at: startedAt.toISOString(),
        submitted_at: now.toISOString(),
        duration_sec: Math.round((now.getTime() - startedAt.getTime()) / 1000),
        answer_transmission_consent: consent,
        difficulty_rating: difficultyRating,
        ai_chat_log: chatMessages,
        response_json,
      })
      .select("id")
      .single();
    setSubmitting(false);

    if (error) {
      toast.error("제출 중 오류가 발생했어요. 다시 시도해 주세요.");
      return;
    }
    if (!submission) {
      toast.error("제출 확인 중 오류가 발생했어요. 다시 시도해 주세요.");
      return;
    }
    void capturePostHogEvent("simulation_submit", {
      simulation_id: String(sim.id),
      simulation_source: sim.simulation_source,
      simulation_context: "standard",
      answer_transmission_consent: consent,
      difficulty_rating: difficultyRating,
    });
    if (typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(draftKey);
      } catch {
        // 무시
      }
    }
    setSubmittedSubmissionId(submission.id);
    setSubmittedAt(now);
    void capturePostHogEvent("simulation_complete", {
      simulation_id: String(sim.id),
      simulation_source: sim.simulation_source,
      simulation_context: "standard",
    });
  };

  if (authLoading || loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-[#EEF0F3] px-4">
        <div className="w-full max-w-2xl">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="mt-6 h-48 w-full" />
        </div>
      </div>
    );
  }

  if (isDemo && sim) return <TrialDemoSimulation />;

  if (!sim || !model) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-[#EEF0F3] px-4 text-center">
        <p className="text-zinc-500">시뮬레이션을 찾을 수 없어요.</p>
        <Link
          to="/simulations"
          className="text-sm text-zinc-500 underline-offset-4 transition-colors hover:text-zinc-900 hover:underline"
        >
          추천 목록으로 돌아가기
        </Link>
      </div>
    );
  }

  if (submittedAt) {
    const resultLink =
      sim.simulation_source === "expert"
        ? {
            to: "/expert-simulation/$id/feedback" as const,
            params: { id: sim.id },
            search: submittedSubmissionId ? { submission: submittedSubmissionId } : {},
          }
        : {
            to: "/simulation/$id/feedback" as const,
            params: { id: sim.id },
            search: submittedSubmissionId ? { submission: submittedSubmissionId } : {},
          };

    return (
      <div className="min-h-dvh bg-[#F0F2F5] px-4 py-12 text-[#171C26] sm:px-6 sm:py-20">
        <main className="mx-auto flex w-full max-w-[520px] flex-col items-center text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full border-[2.5px] border-[#171C26]">
            <CheckCircle2 className="h-6 w-6 text-[#171C26]" strokeWidth={2.5} />
          </div>
          <h1 className="mt-[18px] text-[26px] font-bold tracking-[-0.5px]">제출이 완료됐어요</h1>

          <section className="mt-7 w-full rounded-[20px] bg-[#0F1B2E] p-7 text-left shadow-[0_12px_32px_rgba(15,27,46,0.22)] sm:p-[30px_28px]">
            <div className="flex items-start justify-between gap-3">
              <span className="rounded-full bg-[#4D82D9] px-3 py-[5px] text-xs font-bold text-white">현직자 대화</span>
              <span className="pt-1 text-right text-xs text-[#8B95A5]">취준·이직 상담 후기 4.9 ★</span>
            </div>
            <h2 className="mt-[18px] text-[19px] font-bold leading-[1.4] text-white">
              이 직무, 진짜 나랑 맞을까요?
              <br />
              현직자에게 직접 물어보세요
            </h2>
            <p className="mt-[6px] text-[13.5px] leading-[1.6] text-[#B8C2D4]">
              방금 푼 과제를 실제로 매일 하는 사람과 15분 대화하면, 취업 준비나 이직 전에 궁금했던 현실적인 이야기까지 들을 수 있어요.
            </p>
            <ul className="mt-[18px] space-y-[9px] rounded-xl bg-white/[0.06] p-[14px_16px] text-[13.5px] text-[#DCE3EF]">
              <li className="flex gap-2"><b className="text-[#4D82D9]">✓</b>이 직무 현직자와 1:1 채팅 15분</li>
              <li className="flex gap-2"><b className="text-[#4D82D9]">✓</b>취준·이직 시 필요한 역량 솔직하게 질문</li>
              <li className="flex gap-2"><b className="text-[#4D82D9]">✓</b>내 답안 기반 맞춤 커리어 조언</li>
            </ul>
            <div className="mt-[18px] flex flex-wrap items-center justify-between gap-4 pt-1">
              <div className="flex items-baseline gap-2">
                <span className="text-[13.5px] text-[#7C879B] line-through">19,900원</span>
                <b className="text-[22px] tracking-[-0.4px] text-white">9,900원</b>
              </div>
              <button
                type="button"
                onClick={() => {
                  trackSimulationAction("simulation_expert_chat_clicked");
                  toast("현직자 대화 예약 서비스는 준비 중이에요.");
                }}
                className="rounded-[10px] bg-[#4D82D9] px-[22px] py-[13px] text-[14.5px] font-bold text-white transition-colors hover:bg-[#3d70c4]"
              >
                현직자와 대화하기 →
              </button>
            </div>
          </section>

          <div className="mt-7 flex w-full gap-[10px]">
            <Button asChild className="h-[52px] flex-1 rounded-xl bg-[#171C26] text-[15px] font-bold hover:bg-[#283143]">
              <Link {...resultLink} onClick={() => trackSimulationAction("simulation_result_view_clicked")}>
                결과 화면 보러가기
              </Link>
            </Button>
            <Button asChild variant="outline" className="h-[52px] flex-1 rounded-xl border-[1.5px] border-[#E3E6EC] bg-white text-[15px] font-semibold text-[#171C26] shadow-none hover:bg-[#F7F8FA] hover:text-[#171C26]">
              <Link to="/" onClick={() => trackSimulationAction("simulation_home_return_clicked")}>
                홈화면으로 가기
              </Link>
            </Button>
          </div>
        </main>
      </div>
    );
  }

  const isExpertSimulation = sim.simulation_source === "expert";
  // 미참여(비공식) 기업의 '지원 대비' 시뮬레이션 — 실기업 사칭 방지용 고지·동의 문구 분기.
  const isUnofficial = !isExpertSimulation && !sim.company_is_partner;

  const difficultyBlock = (
    <div className="mt-6 shrink-0 rounded-md border border-zinc-200 p-5">
      <p className="text-sm font-semibold text-zinc-900">이 시뮬레이션의 난이도는 어땠나요?</p>
      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        {DIFFICULTY_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => {
              setDifficultyRating(option.value);
              trackSimulationAction("simulation_difficulty_selected", { difficulty_rating: option.value });
            }}
            className={cn(
              "flex-1 rounded-md border-2 px-2 py-3 text-center text-sm transition-colors",
              difficultyRating === option.value
                ? "border-zinc-900 bg-zinc-900 text-white"
                : "border-zinc-200 bg-white text-zinc-800 hover:border-zinc-400",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );

  const consentBlock = (
    <div className="mt-6 shrink-0 rounded-md border border-zinc-200 p-5">
      <p className="text-sm font-semibold text-zinc-900">
        {isExpertSimulation
          ? "이 답안과 AI 활용 기록을 피드백 화면에 저장할까요?"
          : isUnofficial
            ? `${sim.company_name}가 Beginner에 참여하게 되면 이 답안을 전송하는 것에 동의하시나요?`
            : `이 답안을 ${sim.company_name}에 전송하는 것에 동의하시나요?`}
      </p>
      {isUnofficial ? (
        <p className="mt-1 text-xs text-zinc-400">
          지금은 이 기업이 참여 전이라 답안을 열람할 수 없어요. 나중에 참여하면 동의한 답안만 원문
          그대로 전달돼요. 동의하지 않아도 제출은 되고, 마이페이지 이력에는 남아요.
        </p>
      ) : (
        !isExpertSimulation && (
          <p className="mt-1 text-xs text-zinc-400">
            동의하면 답안 원문이 기업 담당자에게 그대로 전달돼요. 동의하지 않아도 제출 자체는 되고,
            마이페이지 이력에는 남아요.
          </p>
        )
      )}
      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          onClick={() => {
            setConsent(true);
            trackSimulationAction("simulation_submission_consent_selected", { consent: true });
          }}
          className={cn(
            "flex-1 rounded-md border-2 px-4 py-3 text-left text-sm transition-colors",
            consent === true
              ? "border-zinc-900 bg-zinc-900 text-white"
              : "border-zinc-200 bg-white text-zinc-800 hover:border-zinc-400",
          )}
        >
          네, 전송할게요
        </button>
        <button
          type="button"
          onClick={() => {
            setConsent(false);
            trackSimulationAction("simulation_submission_consent_selected", { consent: false });
          }}
          className={cn(
            "flex-1 rounded-md border-2 px-4 py-3 text-left text-sm transition-colors",
            consent === false
              ? "border-zinc-900 bg-zinc-900 text-white"
              : "border-zinc-200 bg-white text-zinc-800 hover:border-zinc-400",
          )}
        >
          아니요, 이번엔 비공개로 할게요
        </button>
      </div>
    </div>
  );

  // ponytail: AI 어시스트는 새 화면 셸에서 숨김 — 되살리려면 아래 렌더 트리에 {aiPanel} 추가
  const aiPanel = (
    <>
      {!chatOpen && (
        <button
          type="button"
          onClick={() => setChatOpen(true)}
          className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-md border border-zinc-900 bg-zinc-900 px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-zinc-700"
          aria-label="AI 어시스트 열기"
        >
          <MessageCircle className="h-5 w-5" />
          <span>AI에게 질문</span>
        </button>
      )}
      {chatOpen && (
        <div className="fixed bottom-6 right-6 z-40 flex h-[520px] w-[360px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-md border border-zinc-200 bg-white">
          <div className="flex items-center justify-between border-b border-zinc-100 bg-zinc-50 px-4 py-3">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-md bg-zinc-900 text-white">
                <MessageCircle className="h-4 w-4" />
              </div>
              <div>
                <p className="text-sm font-semibold text-zinc-900">AI 어시스트</p>
                <p className="text-[11px] text-zinc-400">
                  대화 내용은 제출 시 담당자에게 함께 전달돼요
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setChatOpen(false)}
              className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
              aria-label="닫기"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
            {chatMessages.length === 0 && (
              <div className="flex h-full flex-col items-center justify-center text-center text-xs text-zinc-400">
                <MessageCircle className="mb-2 h-8 w-8 text-zinc-300" />
                과제 이해가 어렵거나 접근 방법이 막힐 때<br />
                편하게 물어보세요.
              </div>
            )}
            {chatMessages.map((m, i) => (
              <div
                key={i}
                className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}
              >
                <div
                  className={cn(
                    "max-w-[80%] whitespace-pre-wrap rounded-md px-3 py-2 text-sm leading-relaxed",
                    m.role === "user" ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-800",
                  )}
                >
                  {m.content}
                </div>
              </div>
            ))}
            {chatSending && (
              <div className="flex justify-start">
                <div className="rounded-md bg-zinc-100 px-3 py-2 text-sm text-zinc-500">
                  생각 중…
                </div>
              </div>
            )}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void sendChat();
            }}
            className="flex items-end gap-2 border-t border-zinc-100 bg-white p-3"
          >
            <Textarea
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value.slice(0, MAX_ANSWER_LENGTH))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void sendChat();
                }
              }}
              placeholder="AI에게 질문하기…"
              maxLength={MAX_ANSWER_LENGTH}
              rows={1}
              className="min-h-9 flex-1 resize-none rounded-md text-sm"
            />
            <Button
              type="submit"
              size="icon"
              disabled={!chatInput.trim() || chatSending}
              className="h-9 w-9 shrink-0 rounded-md bg-zinc-900 text-white hover:bg-zinc-700"
            >
              <Send className="h-4 w-4" />
            </Button>
          </form>
        </div>
      )}
    </>
  );
  void aiPanel;

  const screen = screens[screenIdx] ?? screens[0];
  const nextScreen = screens[screenIdx + 1];
  const topLabel =
    screen.kind === "intro"
      ? "시작"
      : screen.kind === "situation"
        ? "상황 안내"
        : screen.kind === "materials"
          ? "자료 확인"
          : screen.kind === "submit"
            ? "제출"
            : model.steps[screen.stepIndex].title;
  const topStep = screenProgressStep(screen, model.steps.length);

  // 질문 화면 왼쪽/바텀시트 자료 패널
  const questionCtx =
    screen.kind === "question"
      ? getStepMaterialContext(model, model.steps[screen.stepIndex])
      : null;
  const sidebarTabs = questionCtx ? buildSidebarMaterialTabs(questionCtx) : [];

  let mainContent: React.ReactNode;
  let primaryLabel: string;
  let primaryDisabled = false;
  let onPrimary: () => void;

  if (screen.kind === "intro") {
    primaryLabel = "시작하기 →";
    onPrimary = goNext;
    mainContent = (
      <div className="flex min-h-[calc(100dvh-4.5rem)] items-center justify-center px-5 py-10">
        <div className="flex w-full max-w-2xl flex-col items-center gap-5 rounded-2xl border border-zinc-200 bg-white px-8 py-14 text-center sm:px-14">
          <span className="rounded-full border border-zinc-200 px-4 py-1.5 text-xs text-zinc-500">
            {[
              sim.role_label ||
                (isExpertSimulation ? sim.expert_job_title || sim.company_name : sim.company_name),
              sim.estimated_minutes ? `약 ${sim.estimated_minutes}분` : null,
              `${model.steps.length}단계`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          <h1 className="text-2xl font-bold leading-snug tracking-tight text-zinc-900 sm:text-[28px]">
            {sim.title}
          </h1>
          <p className="text-sm leading-relaxed text-zinc-500 sm:text-[15px]">
            {isExpertSimulation
              ? "현직자가 실제 업무를 바탕으로 만든 과제예요."
              : "실제 업무를 바탕으로 만든 과제예요."}
            <br />
            자료를 보고 직접 판단하며 풀어보세요.
          </p>
          {isUnofficial && (
            <div className="flex items-start gap-2 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-left text-xs leading-5 text-zinc-500">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-400" />
              <span>
                이 시뮬레이션은 {sim.company_name}와 무관하며, 공개된 채용공고를 참고해 Beginner가
                제작한 지원 대비용 콘텐츠예요.
              </span>
            </div>
          )}
        </div>
      </div>
    );
  } else if (screen.kind === "situation") {
    primaryLabel = nextScreen?.kind === "materials" ? "자료 확인하러 가기 →" : "다음 →";
    onPrimary = goNext;
    const showSituationVideo =
      screen.stepIndex === 0 && isChipJapanContentMarketerSimulation(sim);
    mainContent = (
      <div className="mx-auto w-full max-w-2xl px-5 py-8 sm:px-12">
        <p className="text-xs text-zinc-500">{showSituationVideo ? "상황 영상" : "상황"}</p>
        {showSituationVideo ? (
          <div className="mt-2 overflow-hidden rounded-xl border border-zinc-200 bg-black">
            <video
              className="aspect-video w-full object-contain"
              controls
              playsInline
              preload="metadata"
            >
              <source src={CHIP_JAPAN_CONTENT_MARKETER_VIDEO} type="video/mp4" />
              이 브라우저에서는 상황 영상을 재생할 수 없습니다.
            </video>
          </div>
        ) : (
          <div className="mt-2 rounded-xl border border-zinc-200 bg-white p-6">
            <RichTextContent
              value={screen.markdown}
              compact
              className="prose prose-sm prose-zinc max-w-none"
            />
          </div>
        )}
        <div className="mt-4 rounded-xl border border-dashed border-zinc-300 p-5">
          <p className="text-xs font-semibold text-zinc-500">이번 시뮬레이션에서 할 일</p>
          <p className="mt-1.5 text-sm text-zinc-700">
            {model.steps.map((s) => s.title).join(" → ")}
          </p>
        </div>
      </div>
    );
  } else if (screen.kind === "materials") {
    primaryLabel = "다음 →";
    onPrimary = goNext;
    const activeTab = screen.tabs[materialTabIdx] ?? screen.tabs[0];
    mainContent = (
      <div className="mx-auto w-full max-w-2xl px-5 py-8 sm:px-12">
        <p className="text-xs text-zinc-500">제공 자료</p>
        <h2 className="mt-1 text-lg font-bold text-zinc-900">자료를 확인하세요</h2>
        <MaterialTabStrip
          tabs={screen.tabs}
          value={materialTabIdx}
          onValueChange={setMaterialTabIdx}
          onTabChange={(tabIndex, tabLabel) =>
            trackSimulationAction("simulation_material_tab_selected", {
              material_area: "materials",
              tab_index: tabIndex,
              tab_label: tabLabel,
            })
          }
          className="mt-4"
        />
        <MaterialBody body={activeTab?.body ?? ""} className="mt-3" />
        <p className="mt-3 text-xs text-zinc-400">자료는 답안 작성 중에도 계속 볼 수 있어요</p>
      </div>
    );
  } else if (screen.kind === "question") {
    const step = model.steps[screen.stepIndex];
    const prompt = step.prompts[screen.promptIndex];
    const answered = getPlainAnswerText(answers[prompt.id] ?? "").length > 0;
    const isLastPromptOfStep = screen.promptIndex === step.prompts.length - 1;
    const showCompletion =
      isLastPromptOfStep && stepAnswered(step, answers) && step.completionMessage;

    primaryDisabled = false;
    primaryLabel =
      nextScreen?.kind === "submit"
        ? "제출하러 가기 →"
        : nextScreen?.kind === "question" && nextScreen.stepIndex === screen.stepIndex
          ? "다음 질문 →"
          : "다음 →";
    onPrimary = () => {
      if (!answered) {
        toast.error("이 질문의 답변을 먼저 작성해주세요.");
        return;
      }

      if (
        AUTHENTICATION_ENABLED &&
        !user &&
        !isOpenView &&
        screen.stepIndex === 0 &&
        screen.promptIndex === 0
      ) {
        try {
          window.localStorage.setItem(draftKey, JSON.stringify({ answers, screenIdx }));
        } catch {
          // 임시저장에 실패해도 로그인 흐름은 계속 진행한다.
        }
        toast("다음 질문으로 넘어가려면 로그인 또는 회원가입이 필요해요.");
        void navigate({ to: "/login", search: { redirect: `/simulation/${id}` } });
        return;
      }

      goNext();
    };

    mainContent = (
      <div className="mx-auto w-full max-w-[1100px] px-5 py-8 sm:px-12">
        <div className="grid gap-6 lg:grid-cols-2 lg:gap-8">
          {sidebarTabs.length > 0 && (
            <div className="hidden lg:sticky lg:top-[5.5rem] lg:block lg:max-h-[calc(100dvh-8rem)] lg:self-start lg:overflow-y-auto">
              <MaterialTabStrip
                tabs={sidebarTabs}
                value={materialTabIdx}
                onValueChange={setMaterialTabIdx}
                onTabChange={(tabIndex, tabLabel) =>
                  trackSimulationAction("simulation_material_tab_selected", {
                    material_area: "sidebar",
                    tab_index: tabIndex,
                    tab_label: tabLabel,
                  })
                }
              />
              <MaterialBody
                body={sidebarTabs[materialTabIdx]?.body ?? sidebarTabs[0]?.body ?? ""}
                className="mt-3"
              />
            </div>
          )}
          <div className="flex flex-col">
            <p className="text-xs text-zinc-500">
              질문 {screen.promptIndex + 1} / {step.prompts.length}
            </p>
            {(step.durationMin != null || step.difficulty != null) && (
              <div className="mt-1 flex items-center gap-2 text-xs text-zinc-400">
                {step.durationMin != null && (
                  <span className="inline-flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" />약 {step.durationMin}분
                  </span>
                )}
                {step.difficulty != null && (
                  <span className="text-zinc-700">
                    {"★".repeat(Math.max(0, Math.min(5, step.difficulty)))}
                    <span className="text-zinc-200">
                      {"★".repeat(Math.max(0, 5 - Math.min(5, step.difficulty)))}
                    </span>
                  </span>
                )}
              </div>
            )}
            {prompt.bodyMarkdown && (
              <div className="mt-2 prose prose-sm prose-zinc max-w-none prose-table:text-sm prose-headings:text-sm prose-headings:font-semibold">
                <RichTextContent value={prompt.bodyMarkdown} compact />
              </div>
            )}
            <AnswerEditor
              value={answers[prompt.id] ?? ""}
              onChange={(value) => setAnswer(prompt.id, value)}
              containerClassName="mt-3"
            />
            {step.hint && (
              <details
                className="mt-4 rounded-xl border border-zinc-200 bg-zinc-50 p-4"
                open={hintOpen}
                onToggle={(e) => {
                  const isOpen = (e.target as HTMLDetailsElement).open;
                  setHintOpen(isOpen);
                  trackSimulationAction(isOpen ? "simulation_hint_opened" : "simulation_hint_closed");
                }}
              >
                <summary className="cursor-pointer list-none text-sm font-semibold text-zinc-700">
                  초심자용 힌트 보기
                </summary>
                <div className="prose prose-sm prose-zinc mt-2 max-w-none prose-table:text-sm">
                  <RichTextContent value={step.hint} compact />
                </div>
              </details>
            )}
            {showCompletion && (
              <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                <div className="prose prose-sm prose-emerald max-w-none">
                  <RichTextContent value={step.completionMessage as string} compact />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  } else if (isDemo) {
    // 데모는 작성까지만 열어둔다. 제출 화면에서는 난이도·동의 대신 신청 안내를 보여준다.
    primaryLabel = "체험 신청하기";
    primaryDisabled = false;
    onPrimary = () => {
      trackSimulationAction("simulation_trial_application_clicked");
      void navigate({ to: "/lp/trial" });
    };
    mainContent = (
      <div className="mx-auto w-full max-w-2xl px-5 py-8 sm:px-12">
        <h2 className="text-lg font-bold text-zinc-900">여기까지가 체험판이에요</h2>
        <p className="mt-2 text-sm leading-6 text-zinc-600">
          실제 과제가 어떤 형식인지 확인하셨어요. 답안 제출과 현직자 모범답안 비교는 체험을 신청하면
          이용할 수 있어요.
        </p>
      </div>
    );
  } else {
    primaryLabel = submitting ? "제출 중..." : "제출하기";
    primaryDisabled = submitting;
    onPrimary = () => {
      trackSimulationAction("simulation_submit_clicked");
      void handleSubmit();
    };
    mainContent = (
      <div className="mx-auto w-full max-w-2xl px-5 py-8 sm:px-12">
        <h2 className="text-lg font-bold text-zinc-900">제출 전에 확인해주세요</h2>
        {difficultyBlock}
        {consentBlock}
      </div>
    );
  }

  const bottomBar = (
    <div>
      {screen.kind === "question" && sidebarTabs.length > 0 && (
        <button
          type="button"
          aria-label="제공 자료 열기"
          onClick={() => {
            setDrawerOpen(true);
            trackSimulationAction("simulation_material_drawer_opened");
          }}
          className="flex h-6 w-full items-center justify-center border-b border-zinc-100 bg-white lg:hidden"
        >
          <span className="h-1 w-8 rounded-full bg-zinc-300" />
        </button>
      )}
      <div className="mx-auto flex w-full max-w-[1100px] items-center gap-2 px-5 py-3.5 sm:px-12">
        {screenIdx > 0 && (
          <Button variant="outline" className="rounded-xl" onClick={goPrev}>
            이전
          </Button>
        )}
        <Button
          onClick={onPrimary}
          disabled={primaryDisabled}
          size="lg"
          className="flex-1 rounded-xl bg-zinc-900 text-white hover:bg-zinc-700"
        >
          {primaryLabel}
        </Button>
      </div>
    </div>
  );

  return (
    <SimulationShell
      label={topLabel}
      step={topStep}
      totalSteps={model.steps.length}
      bottomBar={bottomBar}
      onHomeClick={() => trackSimulationAction("simulation_home_clicked")}
      logoHref={isDemo ? "/lp/trial" : "/"}
    >
      {mainContent}
      {sidebarTabs.length > 0 && (
        <Drawer
          open={drawerOpen}
          onOpenChange={(isOpen) => {
            setDrawerOpen(isOpen);
            if (!isOpen) trackSimulationAction("simulation_material_drawer_closed");
          }}
        >
          <DrawerContent className="max-h-[80dvh]">
            <DrawerHeader>
              <DrawerTitle>제공 자료</DrawerTitle>
            </DrawerHeader>
            <div className="flex flex-col gap-3 overflow-y-auto px-4 pb-6">
              <MaterialTabStrip
                tabs={sidebarTabs}
                value={materialTabIdx}
                onValueChange={setMaterialTabIdx}
                onTabChange={(tabIndex, tabLabel) =>
                  trackSimulationAction("simulation_material_tab_selected", {
                    material_area: "drawer",
                    tab_index: tabIndex,
                    tab_label: tabLabel,
                  })
                }
              />
              <MaterialBody
                body={sidebarTabs[materialTabIdx]?.body ?? sidebarTabs[0]?.body ?? ""}
              />
            </div>
          </DrawerContent>
        </Drawer>
      )}
    </SimulationShell>
  );
}
