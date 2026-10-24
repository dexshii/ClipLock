import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { integration, register, setup } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof setup>>;

describe.skipIf(!integration)('auth and accounts', () => {
  let ctx: Ctx;
  beforeAll(async () => {
    ctx = await setup();
  });
  afterAll(async () => {
    await ctx.app.close();
    await ctx.db.end();
  });

  it('registers, logs in and reads the profile', async () => {
    const { app } = ctx;
    const session = await register(app);
    const dup = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'PLAYER@example.com', password: 'another password', displayName: 'Copy' },
    });
    expect(dup.statusCode).toBe(409);

    const bad = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'player@example.com', password: 'wrong password' } });
    expect(bad.statusCode).toBe(401);
    const unknown = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'nobody@example.com', password: 'whatever' } });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().message).toBe(bad.json().message);

    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${session.accessToken}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ email: 'player@example.com', displayName: 'Player One' });
    expect(me.body).not.toContain('password');
    expect((await app.inject({ method: 'GET', url: '/v1/me' })).statusCode).toBe(401);
  });

  it('rotates refresh tokens and revokes the family on reuse', async () => {
    const { app } = ctx;
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'player@example.com', password: 'correct horse battery' } });
    const first = login.json();
    const r1 = await app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: first.refreshToken } });
    expect(r1.statusCode).toBe(200);
    const second = r1.json();
    // The previous access token stops working after rotation.
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${first.accessToken}` } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${second.accessToken}` } })).statusCode).toBe(200);
    // Replaying the first refresh token is treated as theft.
    const replay = await app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: first.refreshToken } });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error).toBe('token_reused');
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${second.accessToken}` } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: second.refreshToken } })).statusCode).toBe(401);
  });

  it('logs out', async () => {
    const { app } = ctx;
    const s = (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'player@example.com', password: 'correct horse battery' } })).json();
    const out = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { authorization: `Bearer ${s.accessToken}` }, payload: {} });
    expect(out.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${s.accessToken}` } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: s.refreshToken } })).statusCode).toBe(401);
  });

  it('validates input and hides internals', async () => {
    const { app } = ctx;
    const weak = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email: 'x@example.com', password: 'short', displayName: 'X' } });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().error).toBe('invalid_request');
    const notJson = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: 'garbage', headers: { 'content-type': 'application/json' } });
    expect(notJson.statusCode).toBe(400);
    const docs = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(docs.statusCode).toBe(200);
    expect(docs.json().paths['/v1/clips']).toBeDefined();
  });

  it('rate limits login attempts', async () => {
    const { app } = ctx;
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'brute@example.com', password: `guess-${i}` }, remoteAddress: '10.9.9.9' });
      codes.push(res.statusCode);
    }
    expect(codes).toContain(429);
  });

  it('can close registration', async () => {
    const closed = await setup({ ALLOW_REGISTRATION: 'false' });
    const res = await closed.app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email: 'new@example.com', password: 'correct horse battery', displayName: 'New' } });
    expect(res.statusCode).toBe(403);
    await closed.app.close();
    await closed.db.end();
  });
});
