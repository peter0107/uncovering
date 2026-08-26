import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

import {
  COMPANY_AI_PROMPT_DEFAULTS,
  type CompanyAiPromptKey,
} from "@/lib/ai-prompt.defaults";
import { DOMAIN_CATEGORIES } from "@/lib/domain-categories";
import type {
  AdminSimulationPrompt,
  AdminSimulationStep,
  SelectionMode,
  SimulationFormat,
} from "@/lib/simulations.functions";

export const EXPERT_SIMULATION_COMPANY_CODE = "EXPERT-SIMULATIONS-2026";
export const EXPERT_COMPANY_TYPES = [
  "대기업",
  "중견기업",
  "스타트업",
  "외국계",
  "공공기관",
  "기타",
] as const;
export const EXPERT_EXPERIENCE_BANDS = ["1~2년차", "3~5년차", "6~10년차", "10년차 이상"] as const;

export type AdminExpertSimulation = {
  id: string;
  title: string;
  roleLabel: string;
  description: string;
  domain: string;
  estimatedMinutes: number | null;
  simulationFormat: SimulationFormat;
  selectionMode: SelectionMode;
  singleAnswerQuestion: string;
  taskPrompt: string;
  sharedSituation: string;
  sharedMaterials: string;
  steps: AdminSimulationStep[];
  isPublic: boolean;
  nickname: string;
  companyType: (typeof EXPERT_COMPANY_TYPES)[number];
  experienceBand: (typeof EXPERT_EXPERIENCE_BANDS)[number];
  jobTitle: string;
  cardBackgroundColor: string;
  cardTextColor: string;
  profileImageUrl: string;
  modelAnswer: string;
  aiFeedback: string;
  createdAt: string;
};

export type ExpertSimulationFeedback = {
  simulation: {
    id: string;
    title: string;
    roleLabel: string;
    nickname: string;
    companyType: string;
    experienceBand: string;
    jobTitle: string;
    modelAnswer: string;
    aiFeedback: string;
  };
  submission: {
    id: string;
    responseText: string;
    responseAnswers: Array<{ id: string; label: string; answer: string }>;
    aiChatLog: Array<{ role: "user" | "assistant"; content: string; at: string }>;
    submittedAt: string | null;
  };
  aiReview: ExpertAiUtilizationReview | null;
};

export type ExpertAiUtilizationReview = {
  score: number;
  summary: string;
  strengths: string[];
  improvements: string[];
  updatedAt: string;
};

export type AdminExpertSimulationSubmission = {
  id: string;
  applicantName: string;
  submittedAt: string;
  chatMessageCount: number;
  aiReview: ExpertAiUtilizationReview | null;
};

export type PublicExpertSimulationReview = {
  id: string;
  title: string;
  roleLabel: string;
  description: string;
  estimatedMinutes: number | null;
  nickname: string;
  companyType: string;
  experienceBand: string;
  jobTitle: string;
  simulationFormat: SimulationFormat;
  selectionMode: SelectionMode;
  singleAnswerQuestion: string;
  taskPrompt: string;
  sharedSituation: string;
  sharedMaterials: string;
  steps: AdminSimulationStep[];
  /** 시뮬레이션 단위 모범답안 (스텝별 모범답안이 없을 때의 총평) */
  modelAnswer: string;
  /** true면 체험 결제자에게 발송될 주문 전용 과제 — 검수 후 발송된다. */
  isTrial: boolean;
};

const domainCategorySchema = z.enum(DOMAIN_CATEGORIES);
const simulationFormatSchema = z.enum(["single", "selection"]);
const selectionModeSchema = z.enum(["separated", "common"]);
const expertCompanyTypeSchema = z.enum(EXPERT_COMPANY_TYPES);
const expertExperienceBandSchema = z.enum(EXPERT_EXPERIENCE_BANDS);
const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const stepSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  durationMin: z.number().int().positive().optional(),
  difficulty: z.number().int().min(1).max(5).optional(),
  tags: z.array(z.string().min(1)).optional(),
  situation: z.string().optional(),
  materials: z.string().optional(),
  hint: z.string().optional(),
  completionMessage: z.string().optional(),
  prompts: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      body: z.string().optional().default(""),
    }),
  ).max(1),
});

const expertSimulationInputSchema = z.object({
  title: z.string().trim().min(1).max(160),
  roleLabel: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional().default(""),
  domain: domainCategorySchema,
  estimatedMinutes: z.number().int().positive().nullable().optional().default(null),
  simulationFormat: simulationFormatSchema.optional().default("single"),
  selectionMode: selectionModeSchema.optional().default("separated"),
  singleAnswerQuestion: z.string().optional().default(""),
  taskPrompt: z.string().optional().default(""),
  sharedSituation: z.string().optional().default(""),
  sharedMaterials: z.string().optional().default(""),
  steps: z.array(stepSchema).default([]),
  nickname: z.string().trim().min(1).max(60),
  companyType: expertCompanyTypeSchema,
  experienceBand: expertExperienceBandSchema,
  jobTitle: z.string().trim().min(1).max(100),
  cardBackgroundColor: hexColorSchema.default("#ffffff"),
  cardTextColor: hexColorSchema.default("#18181b"),
  profileImageUrl: z
    .union([z.string().url(), z.literal("")])
    .optional()
    .nullable()
    .default(""),
  modelAnswer: z.string().optional().default(""),
  aiFeedback: z.string().optional().default(""),
});

const updateExpertSimulationInputSchema = expertSimulationInputSchema.extend({
  id: z.string().uuid(),
});

const expertSimulationIdSchema = z.object({ id: z.string().uuid() });
const expertSimulationVisibilitySchema = expertSimulationIdSchema.extend({ isPublic: z.boolean() });
const expertSimulationProfileImageSchema = expertSimulationIdSchema.extend({
  profileImageUrl: z.string().url(),
});
const expertSimulationShareLinkSchema = expertSimulationIdSchema;
const publicExpertSimulationReviewSchema = z.object({
  id: z.string().uuid(),
  token: z.string().uuid(),
});
const publicExpertSimulationFeedbackSchema = publicExpertSimulationReviewSchema.extend({
  reviewerName: z.string().trim().max(80).optional().default(""),
  feedback: z.string().trim().min(1).max(5000),
  verdict: z.enum(["approved", "revise"]).optional(),
});

// 검수 링크로 열 수 있는 시뮬레이션 종류.
// 'expert' = 현직자 저작 시뮬레이션 공유 피드백, 'trial' = 체험 주문 전용 과제 검수.
const REVIEWABLE_SOURCES = ["expert", "trial"] as const;
const expertFeedbackInputSchema = z.object({
  simulationId: z.string().uuid(),
  submissionId: z.string().uuid().optional(),
});
const expertSubmissionInputSchema = z.object({ simulationId: z.string().uuid() });
const expertAiEvaluationInputSchema = z.object({
  simulationId: z.string().uuid(),
  submissionId: z.string().uuid(),
});
const expertAiUtilizationSchema = z.object({
  score: z.number().int().min(0).max(100),
  summary: z.string(),
  strengths: z.array(z.string()),
  improvements: z.array(z.string()),
});
const expertAiAnalysisSchema = z.object({ aiUtilization: expertAiUtilizationSchema });

function createPublicServerClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !supabaseKey) throw new Error("Backend is not configured");

  return createClient(supabaseUrl, supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function getBearerToken() {
  const authorization = getRequest()?.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) throw new Error("로그인이 필요합니다.");
  return authorization.slice("Bearer ".length).trim();
}

async function getCurrentUserId() {
  const token = getBearerToken();
  const client = createPublicServerClient();
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) throw new Error("로그인이 필요합니다.");
  return data.user.id;
}

async function assertAdmin() {
  const token = getBearerToken();
  const client = createPublicServerClient();
  const { data, error } = await client.auth.getUser(token);
  if (error || data.user?.app_metadata?.role !== "admin") {
    throw new Error("관리자 권한이 없습니다.");
  }
}

function formatDateTime(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function mapSteps(value: unknown): AdminSimulationStep[] {
  return Array.isArray(value) ? (value as AdminSimulationStep[]) : [];
}

function mapExpertSimulation(row: Record<string, unknown>): AdminExpertSimulation {
  const steps = mapSteps(row.steps);
  return {
    id: String(row.id),
    title: String(row.title ?? ""),
    roleLabel: String(row.role_label ?? row.job_family ?? row.title ?? ""),
    description: String(row.description ?? ""),
    domain: String(row.domain ?? ""),
    estimatedMinutes: typeof row.estimated_minutes === "number" ? row.estimated_minutes : null,
    simulationFormat:
      row.simulation_format === "selection" ||
      (row.simulation_format !== "single" && steps.length > 0)
        ? "selection"
        : "single",
    selectionMode: row.selection_mode === "common" ? "common" : "separated",
    singleAnswerQuestion: String(row.single_answer_question ?? ""),
    taskPrompt: String(row.task_prompt ?? ""),
    sharedSituation: String(row.shared_situation ?? ""),
    sharedMaterials: String(row.shared_materials ?? ""),
    steps,
    isPublic: row.is_public === true,
    nickname: String(row.expert_nickname ?? ""),
    companyType: (EXPERT_COMPANY_TYPES.includes(
      row.expert_company_type as (typeof EXPERT_COMPANY_TYPES)[number],
    )
      ? row.expert_company_type
      : "기타") as (typeof EXPERT_COMPANY_TYPES)[number],
    experienceBand: (EXPERT_EXPERIENCE_BANDS.includes(
      row.expert_experience_band as (typeof EXPERT_EXPERIENCE_BANDS)[number],
    )
      ? row.expert_experience_band
      : "1~2년차") as (typeof EXPERT_EXPERIENCE_BANDS)[number],
    jobTitle: String(row.expert_job_title ?? ""),
    cardBackgroundColor: String(row.card_background_color ?? "#ffffff"),
    cardTextColor: String(row.card_text_color ?? "#18181b"),
    profileImageUrl: String(row.expert_profile_image_url ?? ""),
    modelAnswer: String(row.expert_model_answer ?? ""),
    aiFeedback: String(row.expert_ai_feedback ?? ""),
    createdAt: formatDateTime(String(row.created_at ?? "")),
  };
}

async function getExpertCompanyId() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("companies")
    .select("id")
    .eq("code", EXPERT_SIMULATION_COMPANY_CODE)
    .maybeSingle();

  if (error) throw new Error("현직자 시뮬레이션 정보를 불러오지 못했습니다.");
  if (data?.id) return data.id;

  const { data: created, error: createError } = await supabaseAdmin
    .from("companies")
    .insert({
      name: "현직자 제시 시뮬레이션",
      code: EXPERT_SIMULATION_COMPANY_CODE,
      unique_code: EXPERT_SIMULATION_COMPANY_CODE,
      role_label: "현직자 제시",
      description: "",
    })
    .select("id")
    .single();
  if (createError || !created) throw new Error("현직자 시뮬레이션 정보를 만들지 못했습니다.");
  return created.id;
}

export const getAdminExpertSimulations = createServerFn({ method: "GET" }).handler(
  async (): Promise<AdminExpertSimulation[]> => {
    await assertAdmin();
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("job_simulations")
      .select(
        "id, title, role_label, job_family, description, domain, estimated_minutes, simulation_format, selection_mode, single_answer_question, task_prompt, shared_situation, shared_materials, steps, is_public, expert_nickname, expert_company_type, expert_experience_band, expert_job_title, expert_profile_image_url, card_background_color, card_text_color, expert_model_answer, expert_ai_feedback, created_at",
      )
      .eq("simulation_source", "expert")
      .is("deleted_at", null)
      .order("created_at", { ascending: false });
    if (error) throw new Error("현직자 시뮬레이션을 불러오지 못했습니다.");
    return ((data ?? []) as Record<string, unknown>[]).map(mapExpertSimulation);
  },
);

export const createExpertSimulation = createServerFn({ method: "POST" })
  .inputValidator(expertSimulationInputSchema)
  .handler(async ({ data }) => {
    await assertAdmin();
    const companyId = await getExpertCompanyId();
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: created, error } = await supabaseAdmin
      .from("job_simulations")
      .insert({
        company_id: companyId,
        title: data.title,
        role_label: data.roleLabel,
        job_family: data.roleLabel,
        description: data.description || null,
        domain: data.domain,
        estimated_minutes: data.estimatedMinutes,
        simulation_format: data.simulationFormat,
        selection_mode: data.selectionMode,
        single_answer_question: data.singleAnswerQuestion || null,
        task_prompt: data.taskPrompt || null,
        shared_situation: data.sharedSituation,
        shared_materials: data.sharedMaterials,
        steps: data.steps,
        simulation_source: "expert",
        expert_nickname: data.nickname,
        expert_company_type: data.companyType,
        expert_experience_band: data.experienceBand,
        expert_job_title: data.jobTitle,
        expert_profile_image_url: data.profileImageUrl || null,
        card_background_color: data.cardBackgroundColor,
        card_text_color: data.cardTextColor,
        expert_model_answer: data.modelAnswer || null,
        expert_ai_feedback: data.aiFeedback || null,
        is_public: false,
      })
      .select("id")
      .single();
    if (error || !created) throw new Error("현직자 시뮬레이션을 추가하지 못했습니다.");
    return { id: created.id as string };
  });

export const updateExpertSimulation = createServerFn({ method: "POST" })
  .inputValidator(updateExpertSimulationInputSchema)
  .handler(async ({ data }) => {
    await assertAdmin();
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("job_simulations")
      .update({
        title: data.title,
        role_label: data.roleLabel,
        job_family: data.roleLabel,
        description: data.description || null,
        domain: data.domain,
        estimated_minutes: data.estimatedMinutes,
        simulation_format: data.simulationFormat,
        selection_mode: data.selectionMode,
        single_answer_question: data.singleAnswerQuestion || null,
        task_prompt: data.taskPrompt || null,
        shared_situation: data.sharedSituation,
        shared_materials: data.sharedMaterials,
        steps: data.steps,
        expert_nickname: data.nickname,
        expert_company_type: data.companyType,
        expert_experience_band: data.experienceBand,
        expert_job_title: data.jobTitle,
        expert_profile_image_url: data.profileImageUrl || null,
        card_background_color: data.cardBackgroundColor,
        card_text_color: data.cardTextColor,
        expert_model_answer: data.modelAnswer || null,
        expert_ai_feedback: data.aiFeedback || null,
      })
      .eq("id", data.id)
      .eq("simulation_source", "expert")
      .is("deleted_at", null);
    if (error) throw new Error("현직자 시뮬레이션을 수정하지 못했습니다.");
    return { ok: true };
  });

export const setExpertSimulationVisibility = createServerFn({ method: "POST" })
  .inputValidator(expertSimulationVisibilitySchema)
  .handler(async ({ data }) => {
    await assertAdmin();
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("job_simulations")
      .update({ is_public: data.isPublic })
      .eq("id", data.id)
      .eq("simulation_source", "expert")
      .is("deleted_at", null);
    if (error) throw new Error("공개 상태를 수정하지 못했습니다.");
    return { ok: true };
  });

export const setExpertSimulationProfileImage = createServerFn({ method: "POST" })
  .inputValidator(expertSimulationProfileImageSchema)
  .handler(async ({ data }) => {
    await assertAdmin();
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("job_simulations")
      .update({ expert_profile_image_url: data.profileImageUrl })
      .eq("id", data.id)
      .eq("simulation_source", "expert")
      .is("deleted_at", null);
    if (error) throw new Error("현직자 사진을 저장하지 못했습니다.");
    return { ok: true };
  });

export const getOrCreateExpertSimulationShareLink = createServerFn({ method: "POST" })
  .inputValidator(expertSimulationShareLinkSchema)
  .handler(async ({ data }) => {
    await assertAdmin();
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: simulation, error } = await supabaseAdmin
      .from("job_simulations")
      .select("feedback_share_token")
      .eq("id", data.id)
      .in("simulation_source", REVIEWABLE_SOURCES)
      .is("deleted_at", null)
      .maybeSingle();

    if (error || !simulation) throw new Error("검수할 시뮬레이션을 찾지 못했습니다.");
    if (simulation.feedback_share_token) return { token: simulation.feedback_share_token };

    const token = crypto.randomUUID();
    const { error: updateError } = await supabaseAdmin
      .from("job_simulations")
      .update({ feedback_share_token: token })
      .eq("id", data.id);
    if (updateError) throw new Error("피드백 링크를 만들지 못했습니다.");
    return { token };
  });

export const getPublicExpertSimulationReview = createServerFn({ method: "GET" })
  .inputValidator(publicExpertSimulationReviewSchema)
  .handler(async ({ data }): Promise<PublicExpertSimulationReview> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: simulation, error } = await supabaseAdmin
      .from("job_simulations")
      .select(
        "id, title, role_label, description, estimated_minutes, expert_nickname, expert_company_type, expert_experience_band, expert_job_title, simulation_format, selection_mode, single_answer_question, task_prompt, shared_situation, shared_materials, steps, expert_model_answer, simulation_source",
      )
      .eq("id", data.id)
      .eq("feedback_share_token", data.token)
      .in("simulation_source", REVIEWABLE_SOURCES)
      .is("deleted_at", null)
      .maybeSingle();

    if (error || !simulation) throw new Error("유효하지 않은 피드백 링크입니다.");
    const row = simulation as Record<string, unknown>;
    return {
      id: String(row.id),
      title: String(row.title ?? ""),
      roleLabel: String(row.role_label ?? ""),
      description: String(row.description ?? ""),
      estimatedMinutes: typeof row.estimated_minutes === "number" ? row.estimated_minutes : null,
      nickname: String(row.expert_nickname ?? "현직자"),
      companyType: String(row.expert_company_type ?? ""),
      experienceBand: String(row.expert_experience_band ?? ""),
      jobTitle: String(row.expert_job_title ?? ""),
      simulationFormat: row.simulation_format === "selection" ? "selection" : "single",
      selectionMode: row.selection_mode === "common" ? "common" : "separated",
      singleAnswerQuestion: String(row.single_answer_question ?? ""),
      taskPrompt: String(row.task_prompt ?? ""),
      sharedSituation: String(row.shared_situation ?? ""),
      sharedMaterials: String(row.shared_materials ?? ""),
      steps: mapSteps(row.steps),
      modelAnswer: String(row.expert_model_answer ?? ""),
      isTrial: row.simulation_source === "trial",
    };
  });

export const submitPublicExpertSimulationFeedback = createServerFn({ method: "POST" })
  .inputValidator(publicExpertSimulationFeedbackSchema)
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: simulation, error } = await supabaseAdmin
      .from("job_simulations")
      .select("id")
      .eq("id", data.id)
      .eq("feedback_share_token", data.token)
      .in("simulation_source", REVIEWABLE_SOURCES)
      .is("deleted_at", null)
      .maybeSingle();
    if (error || !simulation) throw new Error("유효하지 않은 피드백 링크입니다.");

    const { error: insertError } = await supabaseAdmin
      .from("expert_simulation_share_feedback")
      .insert({
        simulation_id: simulation.id,
        reviewer_name: data.reviewerName || null,
        feedback: data.feedback,
        verdict: data.verdict ?? null,
      });
    if (insertError) throw new Error("피드백을 저장하지 못했습니다.");

    // 체험 과제가 수정된 뒤 남긴 최신 검수 의견이면 전달 잠금을 해제한다.
    // 기존 피드백 이력은 그대로 보존한다.
    const { error: trialUpdateError } = await supabaseAdmin
      .from("landing_trial_orders")
      .update({
        review_required: false,
        last_reviewed_at: new Date().toISOString(),
      })
      .eq("simulation_id", simulation.id)
      .is("delivered_at", null);
    if (trialUpdateError) {
      console.error("Failed to update trial review state:", trialUpdateError);
      throw new Error("검수 상태를 갱신하지 못했습니다.");
    }
    return { ok: true };
  });

export const deleteExpertSimulation = createServerFn({ method: "POST" })
  .inputValidator(expertSimulationIdSchema)
  .handler(async ({ data }) => {
    await assertAdmin();
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error: submissionError } = await supabaseAdmin
      .from("submissions")
      .delete()
      .eq("job_simulation_id", data.id);
    if (submissionError) throw new Error("연결된 제출 데이터를 삭제하지 못했습니다.");

    const { error } = await supabaseAdmin
      .from("job_simulations")
      .delete()
      .eq("id", data.id)
      .eq("simulation_source", "expert");
    if (error) throw new Error("현직자 시뮬레이션을 삭제하지 못했습니다.");
    return { ok: true };
  });

function mapResponseAnswers(
  value: unknown,
): ExpertSimulationFeedback["submission"]["responseAnswers"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const answers = (value as { answers?: unknown }).answers;
  if (!Array.isArray(answers)) return [];
  return answers.flatMap((answer) => {
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) return [];
    const row = answer as Record<string, unknown>;
    if (typeof row.answer !== "string") return [];
    return [{ id: String(row.id ?? ""), label: String(row.label ?? "답변"), answer: row.answer }];
  });
}

function mapAiChatLog(value: unknown): ExpertSimulationFeedback["submission"]["aiChatLog"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) return [];
    const row = message as Record<string, unknown>;
    if ((row.role !== "user" && row.role !== "assistant") || typeof row.content !== "string")
      return [];
    return [{ role: row.role, content: row.content, at: typeof row.at === "string" ? row.at : "" }];
  });
}

function extractJsonObject(value: string) {
  const trimmed = value
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("AI 응답 형식이 올바르지 않습니다.");
  }
  return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
}

function getClaudeText(payload: Record<string, unknown>) {
  const content = Array.isArray(payload.content) ? payload.content : [];
  return content
    .flatMap((part) =>
      typeof part === "object" &&
      part !== null &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
        ? [(part as { text: string }).text]
        : [],
    )
    .join("\n")
    .trim();
}

function parseExpertAiReview(value: unknown, updatedAt: string): ExpertAiUtilizationReview | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const parsed = expertAiAnalysisSchema.safeParse(value);
  if (!parsed.success) return null;
  return { ...parsed.data.aiUtilization, updatedAt };
}

function getResponseAnswers(value: unknown) {
  return mapResponseAnswers(value).map((answer) => ({ label: answer.label, answer: answer.answer }));
}

export const getAdminExpertSimulationSubmissions = createServerFn({ method: "GET" })
  .inputValidator(expertSubmissionInputSchema)
  .handler(async ({ data }): Promise<AdminExpertSimulationSubmission[]> => {
    await assertAdmin();
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: simulation, error: simulationError } = await supabaseAdmin
      .from("job_simulations")
      .select("company_id")
      .eq("id", data.simulationId)
      .eq("simulation_source", "expert")
      .is("deleted_at", null)
      .maybeSingle();
    if (simulationError || !simulation) throw new Error("현직자 시뮬레이션을 찾을 수 없습니다.");

    const { data: rows, error } = await supabaseAdmin
      .from("submissions")
      .select("id, submitted_at, ai_chat_log, job_seekers(display_name, email)")
      .eq("job_simulation_id", data.simulationId)
      .not("submitted_at", "is", null)
      .order("submitted_at", { ascending: false });
    if (error) throw new Error("제출 답변을 불러오지 못했습니다.");

    const submissionIds = (rows ?? []).map((row) => String(row.id));
    const reviewBySubmission = new Map<string, ExpertAiUtilizationReview>();
    if (submissionIds.length > 0) {
      const { data: reviews, error: reviewError } = await supabaseAdmin
        .from("company_simulation_ai_reviews")
        .select("applicant_id, analysis, created_at, updated_at")
        .eq("company_id", simulation.company_id)
        .in("applicant_id", submissionIds);
      if (reviewError) throw new Error("저장된 AI 평가를 불러오지 못했습니다.");
      for (const review of reviews ?? []) {
        const parsed = parseExpertAiReview(
          review.analysis,
          String(review.updated_at ?? review.created_at ?? ""),
        );
        if (parsed) reviewBySubmission.set(String(review.applicant_id), parsed);
      }
    }

    return (rows ?? []).map((row) => {
      const seeker = row.job_seekers as { display_name?: string | null; email?: string | null } | null;
      const chatLog = mapAiChatLog(row.ai_chat_log);
      return {
        id: String(row.id),
        applicantName: seeker?.display_name || seeker?.email || "이름 미입력",
        submittedAt: formatDateTime(String(row.submitted_at ?? "")),
        chatMessageCount: chatLog.length,
        aiReview: reviewBySubmission.get(String(row.id)) ?? null,
      };
    });
  });

export const evaluateExpertSimulationAiUtilization = createServerFn({ method: "POST" })
  .inputValidator(expertAiEvaluationInputSchema)
  .handler(async ({ data }): Promise<ExpertAiUtilizationReview> => {
    await assertAdmin();
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY 환경변수를 서버 환경에 설정해주세요.");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: simulation, error: simulationError } = await supabaseAdmin
      .from("job_simulations")
      .select("company_id, title, role_label")
      .eq("id", data.simulationId)
      .eq("simulation_source", "expert")
      .is("deleted_at", null)
      .maybeSingle();
    if (simulationError || !simulation) throw new Error("현직자 시뮬레이션을 찾을 수 없습니다.");

    const { data: submission, error: submissionError } = await supabaseAdmin
      .from("submissions")
      .select("id, response_text, response_json, ai_chat_log")
      .eq("id", data.submissionId)
      .eq("job_simulation_id", data.simulationId)
      .not("submitted_at", "is", null)
      .maybeSingle();
    if (submissionError || !submission) throw new Error("제출 답변을 찾을 수 없습니다.");

    const promptKey: CompanyAiPromptKey = "company_ai_utilization_review";
    const { data: savedPrompt } = await supabaseAdmin
      .from("ai_prompt_settings")
      .select("prompt")
      .eq("key", promptKey)
      .maybeSingle();
    const instruction = savedPrompt?.prompt?.trim() || COMPANY_AI_PROMPT_DEFAULTS[promptKey].prompt;
    const material = {
      simulationTitle: simulation.title,
      roleLabel: simulation.role_label,
      responseText: String(submission.response_text ?? ""),
      responseAnswers: getResponseAnswers(submission.response_json),
      aiAssistantChatLog: mapAiChatLog(submission.ai_chat_log),
    };
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
        // Sonnet 5는 thinking을 생략하면 adaptive 사고가 켜져 max_tokens를 잠식한다.
        // 기존 동작(사고 없음)을 유지하려면 명시적으로 끈다.
        thinking: { type: "disabled" },
        max_tokens: 1200,
        messages: [
          {
            role: "user",
            content: `${instruction}\n\n공통 규칙:\n- 제공된 대화 로그와 답변 안에서 확인되는 내용만 평가하세요.\n- 채용 합격/불합격을 판단하지 마세요.\n- 반드시 아래 JSON만 반환하세요.\n{ "aiUtilization": { "score": 0, "summary": "", "strengths": [""], "improvements": [""] } }\n\n평가 자료:\n${JSON.stringify(material).slice(0, 30000)}`,
          },
        ],
      }),
    });
    const payload = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      const message =
        typeof payload.error === "object" &&
        payload.error !== null &&
        typeof (payload.error as { message?: unknown }).message === "string"
          ? (payload.error as { message: string }).message
          : "AI 평가 요청에 실패했습니다.";
      throw new Error(message);
    }

    const output = getClaudeText(payload);
    if (!output) throw new Error("AI 평가 결과를 받지 못했습니다.");
    const analysis = expertAiAnalysisSchema.parse(extractJsonObject(output));
    const now = new Date().toISOString();
    const { data: saved, error: saveError } = await supabaseAdmin
      .from("company_simulation_ai_reviews")
      .upsert(
        {
          company_id: simulation.company_id,
          applicant_id: submission.id,
          analysis,
          updated_at: now,
        },
        { onConflict: "company_id,applicant_id" },
      )
      .select("created_at, updated_at")
      .single();
    if (saveError || !saved) throw new Error("AI 평가 결과를 저장하지 못했습니다.");
    return {
      ...analysis.aiUtilization,
      updatedAt: String(saved.updated_at ?? saved.created_at ?? now),
    };
  });

export const getExpertSimulationFeedback = createServerFn({ method: "GET" })
  .inputValidator(expertFeedbackInputSchema)
  .handler(async ({ data }): Promise<ExpertSimulationFeedback> => {
    const userId = await getCurrentUserId();
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: simulation, error: simulationError } = await supabaseAdmin
      .from("job_simulations")
      .select(
        "id, company_id, title, role_label, expert_nickname, expert_company_type, expert_experience_band, expert_job_title, expert_model_answer, expert_ai_feedback",
      )
      .eq("id", data.simulationId)
      .eq("simulation_source", "expert")
      .maybeSingle();
    if (simulationError || !simulation) throw new Error("현직자 시뮬레이션을 찾을 수 없습니다.");

    let submissionQuery = supabaseAdmin
      .from("submissions")
      .select("id, response_text, response_json, ai_chat_log, submitted_at")
      .eq("job_simulation_id", data.simulationId)
      .eq("job_seeker_id", userId)
      .not("submitted_at", "is", null)
      .order("submitted_at", { ascending: false })
      .limit(1);
    if (data.submissionId) submissionQuery = submissionQuery.eq("id", data.submissionId);
    const { data: submissions, error: submissionError } = await submissionQuery;
    const submission = submissions?.[0];
    if (submissionError || !submission) throw new Error("제출 기록을 찾을 수 없습니다.");

    const { data: reviewRow, error: reviewError } = await supabaseAdmin
      .from("company_simulation_ai_reviews")
      .select("analysis, created_at, updated_at")
      .eq("company_id", simulation.company_id)
      .eq("applicant_id", submission.id)
      .maybeSingle();
    if (reviewError) throw new Error("AI 평가 결과를 불러오지 못했습니다.");

    return {
      simulation: {
        id: String(simulation.id),
        title: String(simulation.title),
        roleLabel: String(simulation.role_label ?? simulation.title),
        nickname: String(simulation.expert_nickname ?? "현직자"),
        companyType: String(simulation.expert_company_type ?? ""),
        experienceBand: String(simulation.expert_experience_band ?? ""),
        jobTitle: String(simulation.expert_job_title ?? ""),
        modelAnswer: String(simulation.expert_model_answer ?? ""),
        aiFeedback: String(simulation.expert_ai_feedback ?? ""),
      },
      submission: {
        id: String(submission.id),
        responseText: String(submission.response_text ?? ""),
        responseAnswers: mapResponseAnswers(submission.response_json),
        aiChatLog: mapAiChatLog(submission.ai_chat_log),
        submittedAt: submission.submitted_at ? String(submission.submitted_at) : null,
      },
      aiReview: reviewRow
        ? parseExpertAiReview(
            reviewRow.analysis,
            String(reviewRow.updated_at ?? reviewRow.created_at ?? ""),
          )
        : null,
    };
  });
