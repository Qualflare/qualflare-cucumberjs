import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** One captured `/api/v1/collect` request. `body` is the parsed JSON (or the
 * raw string if it didn't parse — should never happen for a well-behaved
 * client, but surfaced rather than swallowed if it does). */
export interface CapturedRequest {
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

/** One captured video PUT to a presigned URL this server itself handed out
 * (see `POST /api/v1/attachments/upload-url` below). */
export interface CapturedUpload {
  storageKey: string;
  body: Buffer;
  contentType: string | undefined;
}

export interface MockCollectServer {
  url: string;
  requests: CapturedRequest[];
  uploads: CapturedUpload[];
  /** Queues a specific HTTP status to return for the NEXT `/api/v1/collect`
   * request only; once the queue is empty, subsequent requests get 201 with
   * an incrementing `{seq}`. Lets a test exercise the client's retry path
   * end-to-end (queue a 503, then the client's own retry naturally lands on
   * 201). */
  queueStatus(status: number): void;
  close(): Promise<void>;
}

/** A real local HTTP server, not a mocked/patched client — deliberately, to
 * sidestep any uncertainty about whether a mocking library actually
 * intercepts `undici` traffic (see `test/unit/http-client.test.ts`'s
 * `undici.MockAgent` usage for the parallel reasoning at the unit-test
 * layer: `nock` only patches Node's legacy `http`/`https` modules, which
 * `undici.request()` doesn't go through). This is the real-process
 * equivalent for the integration layer.
 *
 * Also stands in for `POST /api/v1/attachments/upload-url` and the R2 PUT
 * itself — one server, three routes — so the video-upload flow gets the
 * same real-process coverage as `/collect`.
 */
export function startMockCollectServer(): Promise<MockCollectServer> {
  const requests: CapturedRequest[] = [];
  const uploads: CapturedUpload[] = [];
  const statusQueue: number[] = [];
  let seqCounter = 1;
  let uploadCounter = 1;
  let serverUrl = '';

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const url = req.url ?? '';

      if (req.method === 'POST' && url === '/api/v1/collect') {
        let body: unknown = raw.toString('utf8');
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          // Leave `body` as the raw string — a client sending unparseable
          // JSON is itself a bug worth surfacing to whatever asserts on
          // this, not something to hide.
        }
        requests.push({ headers: req.headers, body });

        const status = statusQueue.shift() ?? 201;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        if (status >= 200 && status < 300) {
          res.end(JSON.stringify({ seq: seqCounter }));
          seqCounter += 1;
        } else {
          res.end(
            JSON.stringify({
              code: 'test.forced_error',
              message: `mock-collect-server: forced ${status} response for retry-path testing`,
            }),
          );
        }
        return;
      }

      if (req.method === 'POST' && url === '/api/v1/attachments/upload-url') {
        const { filename } = JSON.parse(raw.toString('utf8')) as { filename: string; mimeType: string; fileSize: number };
        const storageKey = `case-run-attachments/test-project/${uploadCounter}-${filename}`;
        uploadCounter += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ storageKey, uploadUrl: `${serverUrl}/put/${encodeURIComponent(storageKey)}` }));
        return;
      }

      if (req.method === 'PUT' && url.startsWith('/put/')) {
        const storageKey = decodeURIComponent(url.slice('/put/'.length));
        uploads.push({ storageKey, body: raw, contentType: req.headers['content-type'] });
        res.writeHead(200);
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      serverUrl = `http://127.0.0.1:${port}`;
      resolve({
        url: serverUrl,
        requests,
        uploads,
        queueStatus(status: number) {
          statusQueue.push(status);
        },
        close() {
          return new Promise<void>((res) => server.close(() => res()));
        },
      });
    });
  });
}
