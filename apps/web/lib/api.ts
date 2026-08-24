import type {
  AppealDetail,
  AuthUser,
  CreateReportInput,
  FileAppealInput,
  ForgotPasswordInput,
  ListNotificationsQuery,
  ListQueueQuery,
  LoginInput,
  RegisterInput,
  ResetPasswordInput,
  ResolveAppealInput,
  SearchInput,
  SearchResult,
  UpdateReportDraftInput,
  VerifyEmailInput,
  IssueDecisionInput,
  SetDecisionPublishableInput,
  CasePriority,
} from '@safecheck/shared';
import type {
  AppealDetailDto,
  AppealSummaryDto,
  AuthPayload,
  CaseDetailDto,
  CaseSummaryDto,
  DisclosureDto,
  EvidenceDto,
  NotificationsPage,
  PendingAppealDto,
  ReportDetailDto,
  ReportSummaryDto,
} from './api-types';

/**
 * The single HTTP client. Nothing in this app calls `fetch` directly.
 *
 * Two properties of the API's auth design dictate the whole shape of this file:
 *
 *  1. THE ACCESS TOKEN IS NEVER PERSISTED. It lives in the module-scoped
 *     `accessToken` binding below and nowhere else — not localStorage, not
 *     sessionStorage, not a readable cookie. Script injected into this origin
 *     can therefore steal at most a ten-minute credential, and only while the
 *     tab is open. The cost is that a page reload starts with no token, which is
 *     why `restoreSession()` exists and why every authenticated screen renders
 *     on the client.
 *
 *  2. THE REFRESH TOKEN IS AN httpOnly COOKIE WE CANNOT READ. It is scoped by the
 *     API to path `/api/auth`, so it rides along on `POST /api/auth/refresh` and
 *     on nothing else. All we can do is send the request with credentials and see
 *     whether it works — hence `restoreSession()` returning a user rather than
 *     this module ever inspecting a token.
 */

/** Blank by default: same-origin, through the rewrite proxy in next.config.ts. */
const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/+$/, '') || '/api';

let accessToken: string | null = null;

/**
 * Set by the auth provider. The client owns the token, but React owns the user,
 * and a background refresh can produce a fresh user object (a role change, a
 * newly verified email) that the UI has to see. `null` means the session ended.
 */
type SessionListener = (user: AuthUser | null) => void;
let sessionListener: SessionListener | null = null;

export function onSessionChange(listener: SessionListener | null): void {
  sessionListener = listener;
}

/* -------------------------------------------------------------------- errors */

/** Everything a screen needs to render a failure, and nothing a stack trace has. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /**
   * Field-level messages from the server's 422, keyed by field name — the same
   * `z.flattenError().fieldErrors` shape the client's own validation produces, so
   * a form can display either without branching.
   */
  readonly fieldErrors: Record<string, string[]>;
  readonly requestId?: string;

  constructor(
    status: number,
    code: string,
    message: string,
    fieldErrors: Record<string, string[]> = {},
    requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fieldErrors = fieldErrors;
    this.requestId = requestId;
  }

  /** True when the caller is signed out or their session has expired. */
  get isAuthError(): boolean {
    return this.status === 401;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Pull the API's `{ error: { code, message, details } }` envelope apart safely. */
async function toApiError(res: Response): Promise<ApiError> {
  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    // A non-JSON body means something upstream of the API answered — a proxy, or
    // the dev server with the API down. The status is all we can trust.
  }

  const envelope = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
  const code = typeof envelope?.code === 'string' ? envelope.code : `HTTP_${res.status}`;
  const message =
    typeof envelope?.message === 'string'
      ? envelope.message
      : res.status === 0
        ? 'Could not reach SafeCheck.'
        : 'Something went wrong. Please try again.';

  // `details` is fieldErrors for VALIDATION_FAILED and arbitrary for other codes,
  // so it is only trusted when it looks like the map we expect.
  const fieldErrors: Record<string, string[]> = {};
  if (isRecord(envelope?.details)) {
    for (const [field, messages] of Object.entries(envelope.details)) {
      if (Array.isArray(messages)) {
        fieldErrors[field] = messages.filter((m): m is string => typeof m === 'string');
      }
    }
  }

  return new ApiError(
    res.status,
    code,
    message,
    fieldErrors,
    typeof envelope?.requestId === 'string' ? envelope.requestId : undefined,
  );
}

/* ------------------------------------------------------------------- refresh */

/**
 * A single in-flight refresh, shared by every caller.
 *
 * Without this, a screen that fires four requests on mount would send four
 * refreshes when the token expires. Each rotates the token family, so the last
 * three would present a token the first had already consumed — which the API
 * correctly treats as replay and answers by revoking the whole family. The user
 * would be signed out by their own dashboard loading.
 */
let refreshInFlight: Promise<AuthUser | null> | null = null;

async function refreshSession(): Promise<AuthUser | null> {
  refreshInFlight ??= (async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        accessToken = null;
        return null;
      }
      const payload = (await res.json()) as AuthPayload;
      accessToken = payload.accessToken;
      return payload.user;
    } catch {
      accessToken = null;
      return null;
    } finally {
      // Cleared inside the same promise so the next caller starts a new attempt
      // rather than resolving against a stale result.
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

/**
 * Re-establish a session from the refresh cookie. Called once when the app
 * mounts, because a reload always begins with no access token.
 */
export async function restoreSession(): Promise<AuthUser | null> {
  const user = await refreshSession();
  sessionListener?.(user);
  return user;
}

/* ------------------------------------------------------------------ requests */

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** JSON body. Mutually exclusive with `form`. */
  json?: unknown;
  /** Multipart body, for evidence uploads. Content-Type is left to the browser. */
  form?: FormData;
  /** Set false for the handful of endpoints that must not carry a token. */
  auth?: boolean;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
}

function buildUrl(path: string, query: RequestOptions['query']): string {
  if (!query) return `${API_BASE}${path}`;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${API_BASE}${path}?${qs}` : `${API_BASE}${path}`;
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.json !== undefined) headers['content-type'] = 'application/json';
  if (options.auth !== false && accessToken) headers.authorization = `Bearer ${accessToken}`;

  try {
    return await fetch(buildUrl(path, options.query), {
      method: options.method ?? 'GET',
      headers,
      // Always included: the refresh cookie is the only thing that survives a
      // reload, and omitting credentials here would silently break sign-in.
      credentials: 'include',
      body: options.form ?? (options.json !== undefined ? JSON.stringify(options.json) : undefined),
      signal: options.signal,
      cache: 'no-store',
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError(0, 'NETWORK', 'Could not reach SafeCheck. Check your connection.');
  }
}

/**
 * Perform a request, refreshing once on a 401 and replaying it.
 *
 * The retry is deliberately limited to exactly one attempt. If the replay is also
 * rejected, the session is genuinely over and we say so rather than looping.
 */
async function raw(path: string, options: RequestOptions = {}): Promise<Response> {
  let res = await send(path, options);

  if (res.status === 401 && options.auth !== false) {
    const user = await refreshSession();
    if (!user) {
      sessionListener?.(null);
      throw await toApiError(res);
    }
    sessionListener?.(user);
    res = await send(path, options);
    // Still refused with a token we just minted: this is authorisation, not
    // expiry. Ending the session here would be wrong and confusing.
    if (res.status === 401) throw await toApiError(res);
  }

  if (!res.ok) throw await toApiError(res);
  return res;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const res = await raw(path, options);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/* ---------------------------------------------------------------------- auth */

/**
 * Registration never reveals whether the address was already taken — the API
 * answers 202 either way — so there is nothing to return but the address and
 * whether a code is on its way. `verificationRequired` is false when the server
 * has no mail transport configured; the account is then already usable.
 */
async function register(
  input: RegisterInput,
): Promise<{ email: string; verificationRequired: boolean }> {
  return request('/auth/register', { method: 'POST', json: input, auth: false });
}

function adopt(payload: AuthPayload): AuthUser {
  accessToken = payload.accessToken;
  sessionListener?.(payload.user);
  return payload.user;
}

async function login(input: LoginInput): Promise<AuthUser> {
  return adopt(await request<AuthPayload>('/auth/login', { method: 'POST', json: input, auth: false }));
}

async function verifyEmail(input: VerifyEmailInput): Promise<AuthUser> {
  return adopt(
    await request<AuthPayload>('/auth/verify-email', { method: 'POST', json: input, auth: false }),
  );
}

async function resendOtp(email: string, purpose: 'verify_email' | 'login' = 'verify_email'): Promise<void> {
  await request('/auth/resend-otp', { method: 'POST', json: { email, purpose }, auth: false });
}

async function logout(): Promise<void> {
  try {
    await request('/auth/logout', { method: 'POST' });
  } finally {
    // Local state is cleared even if the call failed. A user who clicks sign out
    // must end up signed out on this device regardless of the network.
    accessToken = null;
    sessionListener?.(null);
  }
}

async function changePassword(input: { currentPassword: string; newPassword: string }): Promise<void> {
  await request('/auth/change-password', { method: 'POST', json: input });
  // The API revokes the refresh cookie on a password change, so this session is
  // over by design. Say so by ending it here rather than on the next 401.
  accessToken = null;
  sessionListener?.(null);
}

/**
 * Ask for a reset code by email. Resolves the same way for an address with no
 * account — the API will not say which is which, so neither can this. The screen
 * must therefore move to the code step unconditionally and never claim the mail
 * was sent.
 */
async function forgotPassword(input: ForgotPasswordInput): Promise<void> {
  await request('/auth/forgot-password', { method: 'POST', json: input, auth: false });
}

/**
 * Exchange the code for a new password.
 *
 * Returns no session: the reset revoked every one this account had, and the API
 * deliberately declines to hand a fresh one to whoever made the request. The
 * caller sends the user to sign in.
 */
async function resetPassword(input: ResetPasswordInput): Promise<void> {
  await request('/auth/reset-password', { method: 'POST', json: input, auth: false });
}

/* -------------------------------------------------------------------- search */

async function search(input: SearchInput): Promise<SearchResult> {
  return request('/search', { method: 'POST', json: input });
}

/* ------------------------------------------------------------------- reports */

async function listReports(params: { status?: string; limit?: number } = {}): Promise<ReportSummaryDto[]> {
  const data = await request<{ reports: ReportSummaryDto[] }>('/reports', { query: params });
  return data.reports;
}

async function createReport(input: CreateReportInput): Promise<ReportSummaryDto> {
  const data = await request<{ report: ReportSummaryDto }>('/reports', { method: 'POST', json: input });
  return data.report;
}

async function getReport(id: string): Promise<{ report: ReportDetailDto; evidence: EvidenceDto[] }> {
  return request(`/reports/${id}`);
}

async function updateDraft(id: string, input: UpdateReportDraftInput): Promise<ReportSummaryDto> {
  const data = await request<{ report: ReportSummaryDto }>(`/reports/${id}`, {
    method: 'PATCH',
    json: input,
  });
  return data.report;
}

async function submitReport(id: string): Promise<ReportSummaryDto> {
  const data = await request<{ report: ReportSummaryDto }>(`/reports/${id}/submit`, { method: 'POST' });
  return data.report;
}

async function withdrawReport(id: string, reason: string): Promise<ReportSummaryDto> {
  const data = await request<{ report: ReportSummaryDto }>(`/reports/${id}/withdraw`, {
    method: 'POST',
    json: { reason },
  });
  return data.report;
}

async function uploadEvidence(
  reportId: string,
  file: File,
  caption: string,
): Promise<{ id: string; filename: string; scanStatus: string }> {
  const form = new FormData();
  form.set('file', file);
  if (caption) form.set('caption', caption);
  const data = await request<{ evidence: { id: string; filename: string; scanStatus: string } }>(
    `/reports/${reportId}/evidence`,
    { method: 'POST', form },
  );
  return data.evidence;
}

/**
 * Fetch an evidence file as a blob.
 *
 * It has to go through this client rather than an `<a href>` or an `<img src>`:
 * the endpoint requires a bearer token, and it answers with
 * `Content-Disposition: attachment` plus a locked-down CSP precisely so the
 * bytes can never be rendered in this origin. Callers turn the blob into a
 * short-lived object URL and revoke it.
 */
async function evidenceBlob(evidenceId: string): Promise<{ blob: Blob; filename: string }> {
  const res = await raw(`/evidence/${evidenceId}/content`);
  const disposition = res.headers.get('content-disposition') ?? '';
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  return {
    blob: await res.blob(),
    filename: encoded ? decodeURIComponent(encoded) : `evidence-${evidenceId}`,
  };
}

/* ------------------------------------------------------------------- appeals */

async function fileAppeal(reportId: string, input: FileAppealInput): Promise<AppealDetail> {
  const data = await request<{ appeal: AppealDetailDto }>(`/reports/${reportId}/appeals`, {
    method: 'POST',
    json: input,
  });
  return data.appeal;
}

async function listReportAppeals(reportId: string): Promise<AppealSummaryDto[]> {
  const data = await request<{ appeals: AppealSummaryDto[] }>(`/reports/${reportId}/appeals`);
  return data.appeals;
}

async function listPendingAppeals(limit = 50): Promise<PendingAppealDto[]> {
  const data = await request<{ appeals: PendingAppealDto[] }>('/appeals/pending', { query: { limit } });
  return data.appeals;
}

async function withdrawAppeal(id: string): Promise<AppealDetailDto> {
  const data = await request<{ appeal: AppealDetailDto }>(`/appeals/${id}/withdraw`, { method: 'POST' });
  return data.appeal;
}

async function claimAppeal(id: string): Promise<AppealDetailDto> {
  const data = await request<{ appeal: AppealDetailDto }>(`/appeals/${id}/claim`, { method: 'POST' });
  return data.appeal;
}

async function resolveAppeal(id: string, input: ResolveAppealInput): Promise<AppealDetailDto> {
  const data = await request<{ appeal: AppealDetailDto }>(`/appeals/${id}/resolve`, {
    method: 'POST',
    json: input,
  });
  return data.appeal;
}

/* ---------------------------------------------------------------- moderation */

async function listQueue(query: Partial<ListQueueQuery> = {}): Promise<CaseSummaryDto[]> {
  const data = await request<{ cases: CaseSummaryDto[] }>('/moderation/queue', {
    query: {
      state: query.state,
      priority: query.priority,
      assignedToMe: query.assignedToMe ? 'true' : undefined,
      limit: query.limit ?? 50,
    },
  });
  return data.cases;
}

async function getCase(id: string): Promise<CaseDetailDto> {
  const data = await request<{ case: CaseDetailDto }>(`/moderation/cases/${id}`);
  return data.case;
}

async function assignCase(id: string, moderatorId?: string): Promise<CaseDetailDto> {
  const data = await request<{ case: CaseDetailDto }>(`/moderation/cases/${id}/assign`, {
    method: 'POST',
    json: moderatorId ? { moderatorId } : {},
  });
  return data.case;
}

async function setCaseState(
  id: string,
  state: 'assigned' | 'investigating' | 'awaiting_decision' | 'closed',
): Promise<CaseDetailDto> {
  const data = await request<{ case: CaseDetailDto }>(`/moderation/cases/${id}/state`, {
    method: 'PATCH',
    json: { state },
  });
  return data.case;
}

async function setCasePriority(id: string, priority: CasePriority): Promise<CaseDetailDto> {
  const data = await request<{ case: CaseDetailDto }>(`/moderation/cases/${id}/priority`, {
    method: 'PATCH',
    json: { priority },
  });
  return data.case;
}

async function addCaseNote(id: string, note: string): Promise<CaseDetailDto> {
  const data = await request<{ case: CaseDetailDto }>(`/moderation/cases/${id}/notes`, {
    method: 'POST',
    json: { body: note, visibility: 'internal' },
  });
  return data.case;
}

async function issueDecision(caseId: string, input: IssueDecisionInput): Promise<{ id: string }> {
  const data = await request<{ decision: { id: string } }>(`/moderation/cases/${caseId}/decision`, {
    method: 'POST',
    json: input,
  });
  return data.decision;
}

/**
 * Mark a decision publishable — or withdraw that clearance.
 *
 * The response carries the publication gate's verdict alongside the flag,
 * because they are not the same thing and a moderator who is shown only the flag
 * will assume they are. Callers must surface `disclosure`.
 */
async function setDecisionPublishable(
  decisionId: string,
  input: SetDecisionPublishableInput,
): Promise<{
  decision: { id: string; publishable: boolean; publishableSetBy: string | null };
  disclosure: DisclosureDto;
}> {
  return request(`/moderation/decisions/${decisionId}/publishable`, { method: 'PATCH', json: input });
}

async function getDisclosure(decisionId: string): Promise<DisclosureDto> {
  const data = await request<{ disclosure: DisclosureDto }>(
    `/moderation/decisions/${decisionId}/disclosure`,
  );
  return data.disclosure;
}

/* ------------------------------------------------------------- notifications */

async function listNotifications(query: Partial<ListNotificationsQuery> = {}): Promise<NotificationsPage> {
  return request('/notifications', {
    query: {
      unreadOnly: query.unreadOnly ? 'true' : undefined,
      cursor: query.cursor,
      limit: query.limit ?? 30,
    },
  });
}

/** Omit `ids` to mark everything read. */
async function markNotificationsRead(ids?: string[]): Promise<{ updated: number; unread: number }> {
  return request('/notifications/read', { method: 'POST', json: ids ? { ids } : {} });
}

export const api = {
  register,
  login,
  verifyEmail,
  resendOtp,
  logout,
  changePassword,
  forgotPassword,
  resetPassword,
  search,
  listReports,
  createReport,
  getReport,
  updateDraft,
  submitReport,
  withdrawReport,
  uploadEvidence,
  evidenceBlob,
  fileAppeal,
  listReportAppeals,
  listPendingAppeals,
  withdrawAppeal,
  claimAppeal,
  resolveAppeal,
  listQueue,
  getCase,
  assignCase,
  setCaseState,
  setCasePriority,
  addCaseNote,
  issueDecision,
  setDecisionPublishable,
  getDisclosure,
  listNotifications,
  markNotificationsRead,
};
