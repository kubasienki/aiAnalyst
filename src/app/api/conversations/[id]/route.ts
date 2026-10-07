import { z } from "zod";
import { withConversationApplication } from "../../../../server/conversations/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return withConversationApplication(async service => {
    const { id } = await context.params;
    return service.load(z.uuid().parse(id));
  });
}
