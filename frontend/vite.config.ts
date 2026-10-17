import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

function mockApiPlugin(): Plugin {
  return {
    name: "vite-mock-api-fallback",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url || "";
        if (!url.startsWith("/v1") && !url.startsWith("/auth")) {
          return next();
        }

        try {
          const { handlers } = (await server.ssrLoadModule("/src/mocks/handlers.ts")) as {
            handlers: any[];
          };
          const { getResponse } = (await server.ssrLoadModule("msw")) as {
            getResponse: (handlers: any[], req: Request, ctx: { baseUrl: string }) => Promise<Response | undefined>;
          };

          const host = req.headers.host || "localhost:5174";
          const protocol = "http";
          const fullUrl = `${protocol}://${host}${url}`;

          let bodyString: string | undefined;
          if (req.method !== "GET" && req.method !== "HEAD") {
            const chunks: Buffer[] = [];
            for await (const chunk of req) {
              chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
            }
            if (chunks.length > 0) {
              bodyString = Buffer.concat(chunks).toString("utf8");
            }
          }

          const headers = new Headers();
          for (const [key, val] of Object.entries(req.headers)) {
            if (val !== undefined) {
              if (Array.isArray(val)) {
                val.forEach((v) => headers.append(key, v));
              } else {
                headers.set(key, val);
              }
            }
          }

          const webReq = new Request(fullUrl, {
            method: req.method,
            headers,
            body: bodyString,
          });

          const mockRes = await getResponse(handlers, webReq, {
            baseUrl: `${protocol}://${host}`,
          });

          if (!mockRes) {
            return next();
          }

          res.statusCode = mockRes.status;
          mockRes.headers.forEach((val: string, key: string) => {
            res.setHeader(key, val);
          });

          const arrayBuffer = await mockRes.arrayBuffer();
          res.end(Buffer.from(arrayBuffer));
        } catch (err) {
          console.error("[mock-middleware] Error:", err);
          next();
        }
      });
    },
  };
}

// /v1 and /auth go to the backend in dev, so the app always uses relative paths
// and works from the same origin as the API in production.
export default defineConfig(() => {
  const isMock = process.env.VITE_USE_MOCK === "true";
  return {
    plugins: [react(), tailwindcss(), isMock ? mockApiPlugin() : null],
    server: {
      port: 5174,
      proxy: isMock
        ? undefined
        : {
            "/v1": "http://127.0.0.1:8000",
            "/auth": "http://127.0.0.1:8000",
          },
    },
  };
});
