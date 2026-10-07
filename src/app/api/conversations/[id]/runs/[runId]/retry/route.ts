import { z } from "zod";
import { retrySubmissionSchema } from "../../../../../../../shared/conversations";
import { handleSubmission } from "../../../../../../../server/conversations/http";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string; runId: string }> }) {
  return handleSubmission(request, async (service, body) => {
    const { id, runId } = await context.params;
    return service.retry(z.uuid().parse(id), z.uuid().parse(runId), retrySubmissionSchema.parse(body));
  });
}
