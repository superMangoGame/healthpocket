/**
 * An error the client should render verbatim. `extra` carries the fields the
 * settings page needs to explain a failure - which stage of the Garmin login
 * fell over, and what the user can do about it - and is spread into the JSON
 * error body by `BackendManager.proxy` alongside `detail`.
 */
export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) { super(message) }
}
