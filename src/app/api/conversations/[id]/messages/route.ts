import { z } from "zod";
import { messageSubmissionSchema } from "../../../../../shared/conversations";
import { handleSubmission } from "../../../../../server/conversations/http";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleSubmission(request, async (service, body) => {
    const { id } = await context.params;
    return service.submitMessage(z.uuid().parse(id), messageSubmissionSchema.parse(body));
  });
}
