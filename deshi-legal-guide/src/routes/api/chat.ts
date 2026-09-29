import { createFileRoute } from "@tanstack/react-router";

/**
 * Chat API route — proxies requests to the Python FastAPI backend.
 * The backend handles RAG retrieval (ChromaDB + BM25) and LLM streaming.
 */

// Server-side code reads env vars directly (not VITE_ prefixed)
const BACKEND_URL =
  process.env["VITE_BACKEND_URL"] ||
  process.env["BACKEND_URL"] ||
  "http://localhost:8000";

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return new Response(JSON.stringify({ error: "Invalid request" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        try {
          console.log(`[chat proxy] Forwarding to ${BACKEND_URL}/api/chat`);

          const backendResponse = await fetch(`${BACKEND_URL}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });

          if (!backendResponse.ok) {
            const errorText = await backendResponse.text().catch(() => "Backend error");
            console.error(`[chat proxy] Backend returned ${backendResponse.status}: ${errorText}`);
            return new Response(JSON.stringify({ error: errorText }), {
              status: backendResponse.status,
              headers: { "Content-Type": "application/json" },
            });
          }

          if (!backendResponse.body) {
            console.error("[chat proxy] Backend returned no body");
            return new Response(
              JSON.stringify({ error: "Backend returned empty response" }),
              { status: 502, headers: { "Content-Type": "application/json" } },
            );
          }

          console.log("[chat proxy] Streaming response from backend...");

          // Pipe the SSE stream from the backend directly to the frontend
          return new Response(backendResponse.body, {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache, no-store",
              Connection: "keep-alive",
              "X-Accel-Buffering": "no",
            },
          });
        } catch (error) {
          console.error("[chat proxy] Backend unreachable:", error);
          return new Response(
            JSON.stringify({
              error:
                "Cannot reach the backend server. Make sure it is running with: cd backend && python main.py",
            }),
            {
              status: 502,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
      },
    },
  },
});
