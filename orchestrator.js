// 模型分工编排层：8B 动脑 → 14B 精修 → 7B 提交
// 用法：
//   node orchestrator.js image "想办法画一只深海人鱼"
//   node orchestrator.js video "雨夜街角，一个人撑伞站着"
//   node orchestrator.js diary "今天修了三处 bug，头有点疼"
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const LLM = (process.env.LLM_URL || "http://127.0.0.1:8090").replace(/\/+$/, "");
const COMFY = (process.env.COMFY_URL || "http://127.0.0.1:8188").replace(/\/+$/, "");
const COMFY_OUT = "D:\\AI\\ComfyUI_windows_portable\\ComfyUI\\output";
const OUT_DIR = "D:\\AI\\memory\\images\\orchestrator";

const M7 = "qwen2.5-7b-instruct";
const M8 = "deepseek-r1:8b";
const M14 = "deepseek-r1:14b";

const NEG = "色调艳丽，过曝，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，杂乱的背景";

function stripThink(text) {
  return String(text || "")
    .replace(/<\|[^|]*\|>/g, "")
    .replace(/^(嗯|好的)[，,].{0,120}?\n\n/s, "")
    .trim();
}

async function pin(model) {
  const r = await fetch(LLM + "/admin/active-model", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model }),
  });
  return r.ok;
}

/** 指定模型说一句话，返回纯正文。 */
export async function say(model, system, user, opts = {}) {
  await pin(model);
  const body = {
    model,
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: user },
    ],
    max_tokens: opts.maxTokens || 600,
    temperature: opts.temperature == null ? 0.7 : opts.temperature,
    stream: false,
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 180000);
  try {
    const r = await fetch(LLM + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    const msg = j?.choices?.[0]?.message || {};
    const content = msg.content || msg.reasoning_content || "";
    return stripThink(content);
  } finally {
    clearTimeout(timer);
  }
}

function imageGraph(prompt, opts = {}) {
  const w = opts.width || 512;
  const h = opts.height || 512;
  const seed = opts.seed || Math.floor(Math.random() * 2 ** 31);
  return {
    1: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "DreamShaper_8_pruned.safetensors" } },
    2: { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["1", 1] } },
    3: { class_type: "CLIPTextEncode", inputs: { text: NEG, clip: ["1", 1] } },
    4: { class_type: "EmptyLatentImage", inputs: { width: w, height: h, batch_size: 1 } },
    5: {
      class_type: "KSampler",
      inputs: {
        seed, steps: opts.steps || 25, cfg: opts.cfg || 7,
        sampler_name: "dpmpp_2m", scheduler: "karras", denoise: 1,
        model: ["1", 0], positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0],
      },
    },
    6: { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
    7: { class_type: "SaveImage", inputs: { images: ["6", 0], filename_prefix: "orch" } },
  };
}

/** 7B 提交：把提示词丢给 ComfyUI，等图落地。 */
export async function draw(prompt, opts = {}) {
  const id = Math.random().toString(36).slice(2);
  const body = { prompt: imageGraph(prompt, opts), client_id: id };
  const r = await fetch(COMFY + "/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("ComfyUI 收不下：" + r.status + " " + (await r.text()).slice(0, 200));
  const { prompt_id } = await r.json();

  const started = Date.now();
  for (let i = 0; i < 240; i++) {
    await new Promise((res) => setTimeout(res, 1000));
    const h = await fetch(COMFY + "/history/" + prompt_id).then((x) => x.json()).catch(() => null);
    const hit = h && h[prompt_id];
    if (hit && hit.outputs) {
      const imgs = Object.values(hit.outputs).flatMap((o) => o.images || []);
      if (imgs.length) {
        mkdirSync(OUT_DIR, { recursive: true });
        const src = join(COMFY_OUT, imgs[0].subfolder || "", imgs[0].filename);
        const dst = join(OUT_DIR, imgs[0].filename);
        writeFileSync(dst, readFileSync(src));
        const out = { ok: true, file: dst, prompt, sec: Math.round((Date.now() - started) / 1000), seed: opts.seed || null };
        writeFileSync(join(OUT_DIR, "last.json"), JSON.stringify(out, null, 2), "utf8");
        return out;
      }
    }
  }
  throw new Error("出图超时（4 分钟）");
}

// ---------- 三条流水线 ----------

/** 画图：8B 写初版 → 14B 精修 → 7B 提交出图。 */
export async function imagePipeline(idea, opts = {}) {
  const steps = [];
  let draft = "";
  try {
    draft = await say(M8, "你是画面构思。只输出一条中文画图提示词，60~120 字，不要分镜、不要解释、不要英文。", idea, { maxTokens: 400 });
    steps.push({ who: "8B 初版", out: draft });
  } catch (error) {
    steps.push({ who: "8B 初版", error: error.message });
  }
  let refined = draft;
  try {
    refined = await say(
      M14,
      "你是提示词编辑。把用户给的画图提示词改得更具体：留主体、留场景、补光线和镜头，删空话。只输出一条提示词，不要解释。",
      "原始：\n" + draft + "\n\n我的要求：\n" + idea,
      { maxTokens: 500 }
    );
    steps.push({ who: "14B 精修", out: refined });
  } catch (error) {
    steps.push({ who: "14B 精修", error: error.message });
  }
  if (!refined) throw new Error("两条模型都没给出提示词");
  const pic = await draw(refined, opts);
  steps.push({ who: "7B 提交", out: pic.file, sec: pic.sec });
  return { task: "image", idea, steps, file: pic.file };
}

/** 视频：8B 写镜头 → 14B 收紧 → 返回给调用方去提交（视频太重，默认不自动跑）。 */
export async function videoPipeline(idea, opts = {}) {
  const steps = [];
  const draft = await say(M8, "你是分镜师。输出一条 8~12 秒短视频的镜头描述，中文一段话，写清谁、在哪、做什么、镜头怎么动。", idea, { maxTokens: 400 });
  steps.push({ who: "8B 初版", out: draft });
  const refined = await say(
    M14,
    "你是导演。把这段镜头改成一个连续镜头：不换场景、不换人，光线和情绪写具体。只输出一段话。",
    "原始：\n" + draft + "\n\n我的要求：\n" + idea,
    { maxTokens: 500 }
  );
  steps.push({ who: "14B 精修", out: refined });
  return { task: "video", idea, steps, prompt: refined };
}

/** 日记：8B 写，写崩了让 14B 修。 */
export async function diaryPipeline(input) {
  const steps = [];
  let text = "";
  try {
    text = await say(M8, "你是写日记的人。第一人称，两三句，口语，别抒情过头，别用感叹号堆叠。", input, { maxTokens: 400 });
    steps.push({ who: "8B 写", out: text });
  } catch (error) {
    steps.push({ who: "8B 写", error: error.message });
  }
  const bad = !text || text.length < 12 || /^(抱歉|无法|我不能)/.test(text);
  if (bad) {
    text = await say(M14, "把素材写成两三句第一人称日记，口语，别编素材里没有的事。", input, { maxTokens: 500 });
    steps.push({ who: "14B 修", out: text });
  }
  return { task: "diary", steps, text };
}

const task = process.argv[2];
const arg = process.argv.slice(3).join(" ").trim();
if (task && arg) {
  const run = task === "image" ? imagePipeline : task === "video" ? videoPipeline : task === "diary" ? diaryPipeline : null;
  if (!run) {
    console.log("用法：node orchestrator.js image|video|diary \"内容\"");
    process.exit(1);
  }
  try {
    const r = await run(arg);
    console.log(JSON.stringify(r, null, 2));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exit(1);
  }
}
