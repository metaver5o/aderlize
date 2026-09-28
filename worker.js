// Aderlize Cortinas: API mínima no Cloudflare Workers
// Rotas:
//   POST /simulate  { prompt, images:[composite, room, swatch] }  -> { image: dataURL }
//   POST /upload    (corpo = image/jpeg)                           -> { url }   (opcional, requer R2)
//
// Secrets:  FAL_KEY            (wrangler secret put FAL_KEY)
// Vars:     ALLOWED_ORIGIN     ex.: "https://seu-usuario.github.io"
//           FAL_MODEL          id do endpoint no fal.ai (confira em fal.ai/models)
//           PUBLIC_BUCKET_URL  URL pública do bucket R2 (se usar /upload)
// Binding:  BUCKET             bucket R2 (se usar /upload)

const DEFAULT_MODEL = 'fal-ai/nano-banana-2/edit'; // alternativas: 'fal-ai/flux-2-pro/edit', 'openai/gpt-image-2/edit'
const MAX_PAYLOAD = 12_000_000;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGIN || '*').split(',').map(s => s.trim());
    const okOrigin = allowed.includes('*') || allowed.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': okOrigin ? (origin || '*') : 'null',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin'
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST' || !okOrigin) return json({ error: 'Não permitido' }, 403, cors);

    const path = new URL(request.url).pathname;
    try {
      if (path === '/simulate') return await simulate(request, env, cors);
      if (path === '/upload') return await upload(request, env, cors);
      return json({ error: 'Rota inexistente' }, 404, cors);
    } catch (e) {
      return json({ error: 'Erro interno', detail: String(e).slice(0, 300) }, 500, cors);
    }
  }
};

async function simulate(request, env, cors) {
  const raw = await request.text();
  if (raw.length > MAX_PAYLOAD) return json({ error: 'Imagens grandes demais' }, 413, cors);
  let body; try { body = JSON.parse(raw); } catch { return json({ error: 'JSON inválido' }, 400, cors); }
  const { prompt, images } = body;
  if (typeof prompt !== 'string' || prompt.length > 4000 || !Array.isArray(images) || !images.length || images.length > 4
      || !images.every(i => typeof i === 'string' && i.startsWith('data:image/'))) {
    return json({ error: 'Parâmetros inválidos' }, 400, cors);
  }

  const model = env.FAL_MODEL || DEFAULT_MODEL;
  // Schema comum dos editores com referência no fal (prompt + image_urls). Confira o schema do modelo escolhido.
  const falRes = await fetch(`https://fal.run/${model}`, {
    method: 'POST',
    headers: { Authorization: `Key ${env.FAL_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, image_urls: images, num_images: 1, output_format: 'jpeg' })
  });
  if (!falRes.ok) return json({ error: 'Falha na geração', detail: (await falRes.text()).slice(0, 500) }, 502, cors);

  const data = await falRes.json();
  const url = data?.images?.[0]?.url || data?.image?.url;
  if (!url) return json({ error: 'Resposta sem imagem' }, 502, cors);

  // Devolve como data URL para o navegador poder recortar com máscara sem problema de CORS
  const img = await fetch(url);
  const b64 = toBase64(await img.arrayBuffer());
  return json({ image: `data:${img.headers.get('content-type') || 'image/jpeg'};base64,${b64}`, model }, 200, cors);
}

async function upload(request, env, cors) {
  if (!env.BUCKET || !env.PUBLIC_BUCKET_URL) return json({ error: 'R2 não configurado' }, 501, cors);
  if (!(request.headers.get('Content-Type') || '').startsWith('image/')) return json({ error: 'Envie uma imagem' }, 415, cors);
  const buf = await request.arrayBuffer();
  if (buf.byteLength > 5_000_000) return json({ error: 'Imagem grande demais' }, 413, cors);
  const key = `simulacoes/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.jpg`;
  await env.BUCKET.put(key, buf, { httpMetadata: { contentType: 'image/jpeg' } });
  return json({ url: `${env.PUBLIC_BUCKET_URL.replace(/\/$/, '')}/${key}` }, 200, cors);
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf); let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}
