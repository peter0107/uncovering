import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "@tanstack/react-router";

import { trackSimulationCardClick, type SimulationEntrySource } from "@/lib/posthog";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type StartRequest = {
  id: string;
  title: string;
  source: SimulationEntrySource;
};

type SimulationStartContextValue = {
  startSimulation: (request: StartRequest) => void;
};

const SimulationStartContext = createContext<SimulationStartContextValue | null>(null);

export function SimulationStartProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [request, setRequest] = useState<StartRequest | null>(null);

  const startSimulation = useCallback(
    (nextRequest: StartRequest) => {
      trackSimulationCardClick(nextRequest.id, nextRequest.title, nextRequest.source);
      if (user) {
        void navigate({ to: "/simulation/$id", params: { id: nextRequest.id } });
        return;
      }

      setRequest(nextRequest);
    },
    [navigate, user],
  );

  return (
    <SimulationStartContext.Provider value={{ startSimulation }}>
      {children}
      <Dialog open={Boolean(request)} onOpenChange={(open) => !open && setRequest(null)}>
        <DialogContent className="max-w-sm rounded-lg p-5 shadow-none data-[state=closed]:!animate-none data-[state=open]:!animate-none">
          <DialogHeader>
            <DialogTitle>로그인이 필요합니다</DialogTitle>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRequest(null)}>
              닫기
            </Button>
            <Button
              type="button"
              className="rounded-md bg-zinc-900 text-white hover:bg-zinc-700"
              onClick={() =>
                void navigate({
                  to: "/login",
                  search: { redirect: request ? `/simulation/${request.id}` : "/" },
                })
              }
            >
              로그인
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SimulationStartContext.Provider>
  );
}

export function useSimulationStart() {
  const context = useContext(SimulationStartContext);
  if (!context) {
    throw new Error("useSimulationStart must be used inside SimulationStartProvider.");
  }
  return context;
}
