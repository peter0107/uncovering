import { useEffect } from "react";
import { useRouterState } from "@tanstack/react-router";
import { useAuth } from "@/hooks/use-auth";
import { getPostHogClient } from "@/lib/posthog";
import { stripSensitiveSearchParams } from "@/lib/utils";

const EXCLUDED_POSTHOG_EMAILS = new Set(["standard1414@g.skku.edu"]);
let pageviewCapturePending = false;
let lastCapturedPageviewUrl: string | null = null;

export function PostHogTracker() {
  const locationHref = useRouterState({ select: (state) => state.location.href });
  const { user, loading } = useAuth();
  const email = user?.email?.trim().toLowerCase();
  const userId = user?.id;
  const isExcluded = email ? EXCLUDED_POSTHOG_EMAILS.has(email) : false;

  useEffect(() => {
    if (loading) return;

    let cancelled = false;
    void getPostHogClient().then((posthog) => {
      if (cancelled || !posthog) return;

      if (isExcluded) {
        posthog.reset();
        posthog.opt_out_capturing();
      }
    });

    return () => {
      cancelled = true;
    };
  }, [loading, isExcluded]);

  useEffect(() => {
    if (loading || isExcluded) return;
    const currentUrl = window.location.href;
    if (pageviewCapturePending || lastCapturedPageviewUrl === currentUrl) return;

    pageviewCapturePending = true;
    void getPostHogClient().then((posthog) => {
      if (!posthog || posthog.has_opted_out_capturing()) {
        pageviewCapturePending = false;
        return;
      }

      lastCapturedPageviewUrl = currentUrl;
      posthog.capture("$pageview", {
        $current_url: stripSensitiveSearchParams(currentUrl),
        route: window.location.pathname,
      });
    });
  }, [loading, isExcluded, locationHref]);

  useEffect(() => {
    if (loading || isExcluded) return;

    let cancelled = false;
    void getPostHogClient().then((posthog) => {
      if (cancelled || !posthog || posthog.has_opted_out_capturing()) return;

      if (userId) {
        posthog.identify(userId, email ? { email } : undefined);
        return;
      }
      posthog.reset();
    });

    return () => {
      cancelled = true;
    };
  }, [loading, isExcluded, userId, email]);

  return null;
}
