import type { OrbState } from "../types";

const STATE_LABELS: Record<OrbState, string> = {
  idle: "En veille",
  listening: "Je vous écoute",
  thinking: "Je réfléchis",
  executing: "J’agis",
  speaking: "Je réponds",
  blocked: "Intervention requise",
  permission: "Autorisation requise",
  error: "Un problème est survenu"
};

export function NeptuneOrb({ state }: { state: OrbState }) {
  return (
    <div className={`orb-stage orb-${state}`} aria-label={STATE_LABELS[state]}>
      <div className="orb-halo orb-halo-one" />
      <div className="orb-halo orb-halo-two" />
      <div className="orb-ring orb-ring-one" />
      <div className="orb-ring orb-ring-two" />
      <div className="orb-core">
        <div className="orb-core-glow" />
        <span>N</span>
      </div>
      <div className="orb-particle particle-one" />
      <div className="orb-particle particle-two" />
      <div className="orb-particle particle-three" />
      <p className="orb-state-label">{STATE_LABELS[state]}</p>
    </div>
  );
}
