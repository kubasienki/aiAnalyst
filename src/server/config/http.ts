import "server-only";
import { z } from "zod";
import { apiErrorSchema, chatStreamEventSchema, type ApiError, type ChatStreamEvent } from "../../shared/conversations";
import { openConversationApplication } from "./conversations";
import { ConversationRepositoryError } from "../conversations/repository";
import { ConversationServiceError, type AdmittedSubmission, type ConversationService } from "../conversations/service";

const noCacheHeaders = { "Cache-Control": "no-store" };

function errorResponse(error: unknown): Response {
  let status = 500;
  let payload: ApiError = { code: "internal", message: "The conversation request could not be completed." };
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    status = 400;
    payload = { code: "invalid_input", message: "Invalid request. Check the message and conversation identity." };
  } else if (error instanceof ConversationRepositoryError) {
    switch (error.code) {
      case "not_found":
        status = 404;
        payload = { code: "not_found", message: "Conversation or attempt not found." };
        break;
      case "conflict":
        status = 409;
        payload = { code: error.conflictReason ?? "active_run", message: "Conversation changed or this operation is no longer available. Refresh before sending." };
        break;
      case "invalid_input":
        status = 400;
        payload = { code: "invalid_input", message: "Invalid conversation request." };
        break;
      default:
        status = 503;
        payload = { code: "unavailable", message: "Conversation storage is unavailable. Check status before resending." };
    }
  } else if (error instanceof ConversationServiceError) {
    status = 503;
    payload = { code: error.code, message: error.message };
  }
  return Response.json({ error: apiErrorSchema.parse(payload) }, { status, headers: noCacheHeaders });
}

export async function withConversationApplication(
  action: (service: ConversationService) => Promise<unknown>,
  status = 200,
): Promise<Response> {
  let application: ReturnType<typeof openConversationApplication> | undefined;
  try {
    application = openConversationApplication();
    return Response.json(await action(application.service), { status, headers: noCacheHeaders });
  } catch (error) {
    return errorResponse(error);
  } finally {
    application?.close();
  }
}

function streamExecution(admitted: AdmittedSubmission, request: Request, close: () => void): Response {
  const execution = admitted.execute;
  if (!execution) {
    throw new Error("A newly admitted submission needs an executor.");
  }
  const cancellation = new AbortController();
  const abort = () => cancellation.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) {
    abort();
  }
  let completion: Promise<void> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      function emit(event: ChatStreamEvent): void {
        if (cancellation.signal.aborted) {
          return;
        }
        try {
          const validated = chatStreamEventSchema.parse(event);
          controller.enqueue(encoder.encode(`event: ${validated.kind}\ndata: ${JSON.stringify(validated)}\n\n`));
        } catch {
          // Losing the browser cannot make checkpoint persistence optional.
          // Abort execution and let its awaited cleanup settle before closing DB.
          cancellation.abort();
        }
      }
      emit({ kind: "accepted", runId: admitted.run.id, snapshot: admitted.snapshot });
      completion = (async () => {
        try {
          await execution(cancellation.signal, emit);
        } catch {
          emit({ kind: "error", runId: admitted.run.id, error: {
            code: "synchronization_failed", message: "The analysis outcome could not be confirmed. Check status.",
          } });
        } finally {
          request.signal.removeEventListener("abort", abort);
          close();
          try {
            controller.close();
          } catch {
            // The consumer may already have cancelled this stream.
          }
        }
      })();
      return completion;
    },
    cancel() {
      cancellation.abort();
      return completion;
    },
  });
  return new Response(body, { headers: {
    ...noCacheHeaders,
    "Content-Type": "text/event-stream; charset=utf-8",
    "X-Accel-Buffering": "no",
  } });
}

export async function handleSubmission(
  request: Request,
  admit: (service: ConversationService, body: unknown) => Promise<AdmittedSubmission>,
): Promise<Response> {
  let application: ReturnType<typeof openConversationApplication> | undefined;
  let streamOwnsApplication = false;
  try {
    const body: unknown = await request.json();
    application = openConversationApplication();
    const admitted = await admit(application.service, body);
    if (!admitted.created) {
      return Response.json({ runId: admitted.run.id, snapshot: admitted.snapshot }, {
        status: admitted.run.status === "running" ? 202 : 200,
        headers: noCacheHeaders,
      });
    }
    const response = streamExecution(admitted, request, application.close);
    streamOwnsApplication = true;
    return response;
  } catch (error) {
    return errorResponse(error);
  } finally {
    if (!streamOwnsApplication) {
      application?.close();
    }
  }
}
