# Aderlize Cortinas: simulador de cortinas sob medida

Site estático (um único `index.html`) com simulação da cortina na foto do cliente, orçamento automático e envio pelo WhatsApp. A camada de IA é opcional e roda num Cloudflare Worker, para a chave da API nunca ficar exposta no GitHub.

```
aderlize-cortinas/
├── index.html          ← site completo (HTML + CSS + JS, sem build)
├── tecidos/            ← (opcional) fotos reais das amostras
├── worker/
│   ├── worker.js       ← proxy da IA (fal.ai) + upload opcional no R2
│   └── wrangler.toml
└── README.md
```

## 1. Publicar no GitHub Pages (5 minutos)

1. Crie o repositório `aderlize-cortinas` e suba os arquivos.
2. Settings → Pages → Source: `Deploy from a branch`, branch `main`, pasta `/ (root)`.
3. O site fica em `https://SEU-USUARIO.github.io/aderlize-cortinas/`.
4. Domínio próprio (ex.: `aderlizecortinas.com.br`): crie o arquivo `CNAME` com o domínio e aponte o DNS para o GitHub Pages.

Antes de publicar, edite o bloco `CONFIG` no topo do `<script>`: **o número de WhatsApp da Aderlize** (`WHATSAPP`, só dígitos com 55 + DDD) e os valores de mão de obra, ferragens e instalação. Preços dos tecidos ficam em `TECIDOS`; fatores e valores por modelo em `MODELOS`. Todos os valores atuais são exemplos.

Para usar fotos reais do catálogo, fotografe cada tecido de frente, recorte um quadrado com uma repetição do desenho (30 cm reais por padrão, ajuste em `TILE_M`), salve em `tecidos/` e adicione `img:'tecidos/nome.jpg'` ao item em `TECIDOS`.

## 2. Tech stack

| Camada | MVP 0 (este repositório) | MVP 1 (quando crescer) |
|---|---|---|
| Frontend | HTML/JS puro no GitHub Pages | Next.js (App Router) na Vercel ou Cloudflare Pages |
| API | Cloudflare Worker (proxy da IA) | Mesmo Worker, com rotas de catálogo e orçamentos |
| Catálogo | Array `TECIDOS` no código | Cloudflare D1 (SQLite) ou Supabase (Postgres) + painel admin |
| Imagens | Canvas no navegador | R2 (fotos, simulações, amostras), link público na mensagem |
| Orçamentos | Mensagem no WhatsApp | Tabela `orcamentos` + status (novo, visita, fechado) |

Recomendação: Cloudflare de ponta a ponta (Pages + Workers + D1 + R2). Um fornecedor, plano gratuito cobre o MVP e não há cold start. Supabase é a alternativa se a Aderlize precisar de um painel pronto com login desde cedo.

Esquema sugerido para o MVP 1:

```sql
CREATE TABLE tecidos (
  id TEXT PRIMARY KEY, nome TEXT, categoria TEXT, preco_m REAL,
  largura_rolo REAL, rapport REAL DEFAULT 0, translucidez REAL,
  img_url TEXT, ativo INTEGER DEFAULT 1
);
CREATE TABLE modelos (
  id TEXT PRIMARY KEY, nome TEXT, fator REAL,
  confeccao_m REAL, ferragem_m REAL, ferragem_nome TEXT
);
CREATE TABLE orcamentos (
  id TEXT PRIMARY KEY, criado_em TEXT, nome TEXT, local TEXT,
  modelo_id TEXT, tecido_id TEXT, largura REAL, altura REAL,
  forro INTEGER, instalacao INTEGER, consumo_m REAL, total REAL,
  imagem_url TEXT, status TEXT DEFAULT 'novo'
);
```

## 3. Pipeline visual

O problema dos modelos de inpainting puros (texto + máscara) é que eles inventam a estampa: você pede "floral rosa" e recebe outro floral. Para vender tecido do catálogo, o desenho precisa ser o real. Por isso o pipeline é híbrido, em três etapas:

**Etapa A. Pré-render determinístico (no navegador, grátis, instantâneo).** Já implementado no `index.html`:

1. O cliente marca um retângulo na foto (do trilho até a barra).
2. Escala real: `px_por_metro = largura_retângulo_px / largura_trilho_m`. Isso fixa o tamanho da estampa na foto.
3. A textura do tecido é gerada "plana" com a largura franzida (`largura × fator do modelo`) e depois comprimida coluna a coluna segundo o perfil de dobra de cada modelo (Wave senoidal, Americana com pinças, Macho em caixa, Ilhós com ondas irregulares). Nas partes inclinadas da dobra cabe mais tecido por pixel, como na realidade.
4. Sombreamento por coluna (oclusão nos vales, brilho nas cristas), barra ondulada, sombra projetada na parede e ferragem (trilho ou varão com argolas). Tecidos translúcidos (voil) são compostos com transparência.

**Etapa B. Harmonização por IA (opcional, ~R$ 0,30 a R$ 1 por imagem).** O Worker envia três imagens para um editor multi-referência:

1. o composite da etapa A (posição, tamanho, estampa e escala corretos);
2. a sala original;
3. a amostra do tecido.

O modelo só precisa deixar a cortina fotorrealista (física do tecido, luz da janela, sombras), sem decidir onde ela fica nem qual é o desenho.

Modelos indicados no fal.ai (troque em `FAL_MODEL` sem mexer no código; confira o id exato e o schema em fal.ai/models):

| Modelo | Quando usar |
|---|---|
| Nano Banana 2 Edit | Padrão: rápido, barato, aceita várias imagens de referência sem máscara |
| FLUX.2 [pro] Edit | Boa consistência com múltiplas referências; alternativa se a estampa "derreter" |
| GPT Image 2 Edit | Aceita máscara; útil para edições confinadas a uma região, custo maior |

Replicate também serve (mesmos modelos em geral). Para janelas muito em ângulo, o próximo passo é ControlNet de profundidade + inpainting (FLUX Fill com depth), mas no MVP a etapa A já resolve a perspectiva frontal.

**Etapa C. Paste-back com máscara (no navegador).** Nenhum modelo de edição garante 100% que não mexe no resto da foto. Então o resultado da IA é recortado pela área da cortina (com borda suavizada) e colado sobre a foto original. Resultado: fora da cortina, os pixels são literalmente os do cliente.

Roadmap visual:
- Detecção automática da janela (Grounding DINO + SAM 2 no fal) para sugerir o retângulo.
- Marcação por 4 pontos + homografia para fotos tiradas de lado.
- Fila assíncrona (`queue.fal.run` + webhook) se o tempo de resposta passar de ~25 s.

## 4. Motor de orçamento

```
largura_trilho  = largura_vão + 2 × sobra_lateral            (0,10 m por lado)
largura_plana   = largura_trilho × fator_modelo
altura_corte    = altura + barra + cabeçote                  (0,15 + 0,10 m)
```

Fatores de franzido usados: Wave 2,5 · Prega Americana 2,8 · Prega Macho 3,0 · Varão com Ilhós 2,0 (ajuste à prática da Aderlize).

Consumo depende de como o tecido é cortado:

```
Se altura_corte ≤ largura_rolo − 0,03   (tecido "de altura", típico de rolos de 2,80–3,00 m)
    consumo = largura_plana + bainhas_laterais               (0,20 m)
Senão                                   (tecido "de largura", típico de 1,40 m, emendado em panos)
    panos   = ⌈(largura_plana + bainhas_laterais) / (largura_rolo − costura)⌉
    corte   = ⌈altura_corte / rapport⌉ × rapport             (rapport = repetição vertical da estampa)
    consumo = panos × corte
consumo arredondado para cima em 0,10 m
```

Preço:

```
tecido     = consumo × preço_m
forro      = consumo_forro × preço_forro_m                   (mesma lógica, rolo 2,80 m)
confecção  = largura_trilho × confecção_m_do_modelo × (1,3 se tiver forro)
ferragem   = largura_trilho × ferragem_m_do_modelo
instalação = base + largura_trilho × valor_m
total      = soma; o cliente vê o total e uma faixa de ±10%
```

Exemplo (Wave, Linho Cru R$ 69,90/m, vão 2,40 × 2,50 m): trilho 2,60 m, tecido plano 6,50 m, consumo 6,70 m.

## 5. Prompt base

O `index.html` monta o prompt a partir do modelo e do tecido escolhidos (campo `en` em `MODELOS` e `TECIDOS`). Estrutura:

```
Photorealistic interior photo edit.
Image 1 is the customer's room with a rough digital preview of new curtains already placed.
Image 2 is the same room without curtains. Image 3 is the exact fabric swatch.
Re-render ONLY the curtains as real {ripplefold curtains on a slim ceiling track...},
made of {natural undyed linen with visible slub texture}.
Match the swatch exactly: same colors, same pattern and same pattern scale as in image 1.
Do not recolor, simplify or invent a new pattern.
Keep the curtain position, size, opening width and hardware exactly as in image 1.
Add natural fabric physics: soft fold shading, subtle hem, gentle contact shadows on the wall,
lighting consistent with the room and window light.
Everything else must remain pixel-identical to image 2: walls, window, furniture, floor,
decor, camera angle, perspective, white balance.
No people, no text, no watermark, no extra objects.
```

Parâmetros: imagens em JPEG 0,88 com lado maior até 1600 px; `num_images: 1`; saída JPEG. Se usar um modelo de inpainting clássico com `strength`/`guidance`, comece com strength 0,35–0,5 sobre o composite (baixo o bastante para manter a estampa) e guidance 3–4.

## 6. Ligar a IA (Cloudflare Worker)

```bash
cd worker
npm i -g wrangler
wrangler login
wrangler secret put FAL_KEY          # chave criada em fal.ai/dashboard/keys
# edite ALLOWED_ORIGIN no wrangler.toml com o endereço do GitHub Pages
wrangler deploy
```

Depois, em `index.html`: `API_BASE: 'https://aderlize-api.SEU-USUARIO.workers.dev'`.

Para a imagem ir como link dentro da mensagem do WhatsApp: crie um bucket R2 com acesso público, descomente o bloco `r2_buckets`, preencha `PUBLIC_BUCKET_URL` e ligue `SALVAR_IMAGEM_NA_NUVEM: true`.

Antes de divulgar: ative Rate Limiting no Worker (ou Turnstile no botão da IA) e defina um limite de gasto na conta do fal, porque o endpoint é público.

## 7. Sobre o envio pelo WhatsApp

O link `wa.me` só aceita texto; não existe forma de anexar imagem automaticamente por ele. O site faz o seguinte:

- sem R2: baixa a imagem da simulação e abre a conversa com o orçamento já escrito; o cliente anexa a imagem;
- no celular: o botão "Compartilhar imagem da simulação" usa o compartilhamento nativo e manda imagem + texto juntos (o cliente escolhe o contato da Aderlize);
- com R2: a mensagem já inclui o link da imagem.

Com volume, o passo seguinte é a WhatsApp Cloud API (template de mensagem + mídia), mas ela exige conta Business verificada e custa por conversa.

## 8. LGPD

Fotos do interior da casa são dados pessoais. No MVP 0 a foto não sai do navegador, exceto quando o cliente usa a IA. Se ativar R2, informe no site que a imagem é armazenada para o atendimento e configure uma regra de expiração (ex.: 90 dias) no bucket.
