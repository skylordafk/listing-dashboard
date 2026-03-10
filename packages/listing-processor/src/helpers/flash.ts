// Flash message helpers using signed cookies.

export interface FlashMsg { category: string; message: string; }

export function setFlash(reply: any, messages: FlashMsg[]): void {
  const existing = getFlashFromCookie(reply.request);
  const all = [...existing, ...messages];
  reply.setCookie('__flash', JSON.stringify(all), {
    path: '/', httpOnly: true, maxAge: 30, signed: true,
  });
}

export function flash(reply: any, category: string, message: string): void {
  setFlash(reply, [{ category, message }]);
}

export function getFlashFromCookie(request: any): FlashMsg[] {
  try {
    const raw = request.unsignCookie(request.cookies.__flash ?? '');
    if (!raw.valid || !raw.value) return [];
    return JSON.parse(raw.value) as FlashMsg[];
  } catch { return []; }
}

export function consumeFlash(request: any, reply: any): FlashMsg[] {
  const messages = getFlashFromCookie(request);
  if (messages.length > 0) {
    reply.clearCookie('__flash', { path: '/' });
  }
  return messages;
}
