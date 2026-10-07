import AgentDebugView from "./view";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default function AgentDebugPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }
  return <AgentDebugView />;
}
