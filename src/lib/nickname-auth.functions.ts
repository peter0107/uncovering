import { z } from "zod";

const nicknameSchema = z.string().trim().toLowerCase().min(2).max(20).regex(/^[0-9a-z가-힣_-]+$/);
const ADMIN_NICKNAME = "beginner";
const ADMIN_EMAIL = "u.ncovering2026@gmail.com";
const json = (body: Record<string, unknown>, status = 200) => Response.json(body, { status });

export async function handleNicknameCheckRequest(request: Request) {
  const parsed = nicknameSchema.safeParse(new URL(request.url).searchParams.get("nickname") ?? "");
  if (!parsed.success) return json({ error: "사용할 수 없는 닉네임 형식입니다." }, 400);
  if (parsed.data === ADMIN_NICKNAME) return json({ available: false, admin: true });
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin.from("job_seekers").select("id").eq("nickname", parsed.data).limit(1).maybeSingle();
  if (error) return json({ error: "닉네임을 확인하지 못했습니다." }, 500);
  return json({ available: !data });
}

export async function handleNicknameLoginRequest(request: Request) {
  const payload = (await request.json().catch(() => null)) as { nickname?: unknown; password?: unknown } | null;
  const parsed = nicknameSchema.safeParse(payload?.nickname);
  if (!parsed.success) return json({ error: "닉네임은 2~20자의 한글, 영문, 숫자로 입력해주세요." }, 400);
  const nickname = parsed.data;
  const isAdmin = nickname === ADMIN_NICKNAME;
  if (!isAdmin) return json({ error: "닉네임 로그인은 더 이상 사용할 수 없습니다." }, 403);
  const configuredPassword = process.env.ADMIN_PASSWORD?.trim() || "beginner";
  if (isAdmin && payload?.password !== configuredPassword) return json({ error: "관리자 비밀번호가 올바르지 않습니다." }, 403);

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const email = ADMIN_EMAIL;

  if (isAdmin) {
    const { data: users, error: usersError } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (usersError) return json({ error: "관리자 계정을 확인하지 못했습니다." }, 500);
    const adminUser = users.users.find((user) => user.email?.toLowerCase() === email.toLowerCase());
    if (!adminUser) return json({ error: "관리자 계정을 찾지 못했습니다." }, 500);

    // 비밀번호를 바꾸면 GoTrue가 이 계정의 기존 refresh token을 전부 폐기한다. 관리자는
    // 계정 하나를 공유하므로, 매 로그인마다 재설정하면 다른 기기·탭에서 먼저 로그인한
    // 관리자의 세션이 조용히 죽는다(JWT는 만료 전이라 화면은 정상, getUser만
    // session_not_found로 실패). 그래서 로그인을 먼저 시도하고, 실패할 때만 재설정한다.
    let { data: adminSession, error: signInError } = await supabaseAdmin.auth.signInWithPassword({
      email,
      password: configuredPassword,
    });

    if (signInError) {
      const { error: resetError } = await supabaseAdmin.auth.admin.updateUserById(adminUser.id, {
        password: configuredPassword,
        app_metadata: { role: "admin" },
      });
      if (resetError) return json({ error: "관리자 권한을 발급하지 못했습니다." }, 500);
      ({ data: adminSession, error: signInError } = await supabaseAdmin.auth.signInWithPassword({
        email,
        password: configuredPassword,
      }));
    } else if (adminUser.app_metadata?.role !== "admin") {
      // app_metadata만 바꾸는 갱신은 세션을 폐기하지 않는다.
      const { error: roleError } = await supabaseAdmin.auth.admin.updateUserById(adminUser.id, {
        app_metadata: { role: "admin" },
      });
      if (roleError) return json({ error: "관리자 권한을 발급하지 못했습니다." }, 500);
    }

    if (signInError || !adminSession.session) return json({ error: "관리자 로그인을 시작하지 못했습니다." }, 500);
    return json({
      accessToken: adminSession.session.access_token,
      refreshToken: adminSession.session.refresh_token,
      admin: true,
    });
  }

  return json({ error: "닉네임 로그인은 더 이상 사용할 수 없습니다." }, 403);
}
