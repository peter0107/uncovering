import {
  createContext,
  useCallback,
  useContext,
  type ReactNode,
} from "react";
import { useNavigate } from "@tanstack/react-router";

import { trackSimulationCardClick, type SimulationEntrySource } from "@/lib/posthog";

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

  const startSimulation = useCallback(
    (nextRequest: StartRequest) => {
      trackSimulationCardClick(nextRequest.id, nextRequest.title, nextRequest.source);
      void navigate({ to: "/simulation/$id", params: { id: nextRequest.id } });
    },
    [navigate],
  );

  return (
    <SimulationStartContext.Provider value={{ startSimulation }}>
      {children}
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
