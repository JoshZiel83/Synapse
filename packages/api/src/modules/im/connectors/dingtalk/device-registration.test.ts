import test from "node:test"
import assert from "node:assert/strict"
import {
  createOpenclawProvider,
  RegistrationBusinessError,
  RegistrationTransientError,
  resolveProviderMode,
} from "./device-registration.js"

interface MockFetchOptions {
  responses: Array<{
    status: number
    body?: unknown
    throws?: Error
  }>
}

function makeMockFetch(opts: MockFetchOptions) {
  let i = 0
  const fn = async (
    _input: Parameters<typeof fetch>[0],
    _init?: Parameters<typeof fetch>[1]
  ): Promise<Response> => {
    const r = opts.responses[i++]
    if (!r) throw new Error("mock fetch ran out of responses")
    if (r.throws) throw r.throws
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status })
  }
  return fn as unknown as typeof fetch
}

test("openclawProvider.init: parses nonce on success", async () => {
  const provider = createOpenclawProvider({
    fetch: makeMockFetch({
      responses: [{ status: 200, body: { errcode: 0, nonce: "n-1" } }],
    }),
  })
  const r = await provider.init()
  assert.equal(r.nonce, "n-1")
})

test("openclawProvider.init: errcode !=0 throws RegistrationBusinessError", async () => {
  const provider = createOpenclawProvider({
    fetch: makeMockFetch({
      responses: [
        { status: 200, body: { errcode: 88001, errmsg: "source disabled" } },
      ],
    }),
  })
  await assert.rejects(
    provider.init(),
    (err: unknown) =>
      err instanceof RegistrationBusinessError &&
      /errcode=88001/.test((err as Error).message)
  )
})

test("openclawProvider.init: 5xx throws RegistrationTransientError", async () => {
  const provider = createOpenclawProvider({
    fetch: makeMockFetch({
      responses: [{ status: 503, body: { errcode: 0 } }],
    }),
  })
  await assert.rejects(
    provider.init(),
    (err: unknown) => err instanceof RegistrationTransientError
  )
})

test("openclawProvider.init: network error throws RegistrationTransientError", async () => {
  const provider = createOpenclawProvider({
    fetch: makeMockFetch({
      responses: [{ status: 0, throws: new Error("ECONNRESET") }],
    }),
  })
  await assert.rejects(
    provider.init(),
    (err: unknown) => err instanceof RegistrationTransientError
  )
})

test("openclawProvider.init: missing nonce throws RegistrationBusinessError", async () => {
  const provider = createOpenclawProvider({
    fetch: makeMockFetch({
      responses: [{ status: 200, body: { errcode: 0 } }],
    }),
  })
  await assert.rejects(
    provider.init(),
    (err: unknown) => err instanceof RegistrationBusinessError
  )
})

test("openclawProvider.begin: returns device flow descriptor", async () => {
  const provider = createOpenclawProvider({
    fetch: makeMockFetch({
      responses: [
        {
          status: 200,
          body: {
            errcode: 0,
            device_code: "dc-1",
            user_code: "USR-1",
            verification_uri: "https://login.dingtalk.com/uc",
            verification_uri_complete: "https://login.dingtalk.com/uc?dc=1",
            expires_in: 600,
            interval: 5,
          },
        },
      ],
    }),
  })
  const r = await provider.begin({ nonce: "n-1" })
  assert.equal(r.deviceCode, "dc-1")
  assert.equal(r.userCode, "USR-1")
  assert.equal(r.expiresInSeconds, 600)
  assert.equal(r.intervalSeconds, 5)
})

test("openclawProvider.begin: errcode != 0 throws RegistrationBusinessError", async () => {
  const provider = createOpenclawProvider({
    fetch: makeMockFetch({
      responses: [{ status: 200, body: { errcode: 99, errmsg: "no quota" } }],
    }),
  })
  await assert.rejects(
    provider.begin({ nonce: "n-1" }),
    (err: unknown) => err instanceof RegistrationBusinessError
  )
})

test("openclawProvider.begin: 5xx throws RegistrationTransientError", async () => {
  const provider = createOpenclawProvider({
    fetch: makeMockFetch({
      responses: [{ status: 502, body: {} }],
    }),
  })
  await assert.rejects(
    provider.begin({ nonce: "n-1" }),
    (err: unknown) => err instanceof RegistrationTransientError
  )
})

test("openclawProvider.poll: WAITING maps to lowercase 'waiting'", async () => {
  const provider = createOpenclawProvider({
    fetch: makeMockFetch({
      responses: [{ status: 200, body: { errcode: 0, status: "WAITING" } }],
    }),
  })
  const r = await provider.poll({ deviceCode: "dc-1" })
  assert.equal(r.status, "waiting")
})

test("openclawProvider.poll: SUCCESS with credentials maps to 'success'", async () => {
  const provider = createOpenclawProvider({
    fetch: makeMockFetch({
      responses: [
        {
          status: 200,
          body: {
            errcode: 0,
            status: "SUCCESS",
            client_id: "ding-1",
            client_secret: "secret-1",
          },
        },
      ],
    }),
  })
  const r = await provider.poll({ deviceCode: "dc-1" })
  assert.equal(r.status, "success")
  assert.equal(r.clientId, "ding-1")
  assert.equal(r.clientSecret, "secret-1")
})

test("openclawProvider.poll: SUCCESS without credentials degrades to 'fail'", async () => {
  const provider = createOpenclawProvider({
    fetch: makeMockFetch({
      responses: [{ status: 200, body: { errcode: 0, status: "SUCCESS" } }],
    }),
  })
  const r = await provider.poll({ deviceCode: "dc-1" })
  assert.equal(r.status, "fail")
})

test("openclawProvider.poll: FAIL surfaces provider message", async () => {
  const provider = createOpenclawProvider({
    fetch: makeMockFetch({
      responses: [
        {
          status: 200,
          body: { errcode: 0, status: "FAIL", fail_reason: "user denied" },
        },
      ],
    }),
  })
  const r = await provider.poll({ deviceCode: "dc-1" })
  assert.equal(r.status, "fail")
  assert.match(r.message ?? "", /user denied/)
})

test("openclawProvider.poll: EXPIRED maps to lowercase 'expired'", async () => {
  const provider = createOpenclawProvider({
    fetch: makeMockFetch({
      responses: [{ status: 200, body: { errcode: 0, status: "EXPIRED" } }],
    }),
  })
  const r = await provider.poll({ deviceCode: "dc-1" })
  assert.equal(r.status, "expired")
})

test("openclawProvider.poll: UNKNOWN maps to 'fail' with descriptive message", async () => {
  const provider = createOpenclawProvider({
    fetch: makeMockFetch({
      responses: [{ status: 200, body: { errcode: 0, status: "UNKNOWN" } }],
    }),
  })
  const r = await provider.poll({ deviceCode: "dc-1" })
  assert.equal(r.status, "fail")
  assert.match(r.message ?? "", /unknown status/)
})

test("resolveProviderMode: defaults to 'auto'", () => {
  const prev = process.env.DINGTALK_REGISTRATION_PROVIDER
  try {
    delete process.env.DINGTALK_REGISTRATION_PROVIDER
    assert.equal(resolveProviderMode(), "auto")
  } finally {
    if (prev !== undefined) process.env.DINGTALK_REGISTRATION_PROVIDER = prev
  }
})

test("resolveProviderMode: explicit env values are honored", () => {
  const prev = process.env.DINGTALK_REGISTRATION_PROVIDER
  try {
    process.env.DINGTALK_REGISTRATION_PROVIDER = "openclaw"
    assert.equal(resolveProviderMode(), "openclaw")
    process.env.DINGTALK_REGISTRATION_PROVIDER = "disabled"
    assert.equal(resolveProviderMode(), "disabled")
    process.env.DINGTALK_REGISTRATION_PROVIDER = "auto"
    assert.equal(resolveProviderMode(), "auto")
    process.env.DINGTALK_REGISTRATION_PROVIDER = "garbage"
    assert.equal(resolveProviderMode(), "auto")
  } finally {
    if (prev === undefined) delete process.env.DINGTALK_REGISTRATION_PROVIDER
    else process.env.DINGTALK_REGISTRATION_PROVIDER = prev
  }
})
