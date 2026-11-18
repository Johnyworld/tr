/**
 * 초상화 생성기: 월드 팩의 art/portraits.yaml을 읽어 로컬 ComfyUI(HTTP API)로 그림을 만든다.
 * 게임 코드가 아니라 콘텐츠를 만드는 도구다 (core·mcp·ui 어디서도 부르지 않는다).
 *
 *   pnpm portraits <월드> [--style C] [--only a,b] [--force] [--variants N] [--dry]
 *
 * - 얼굴(faces)마다 자기 화풍(style)으로 그린다. 결과: content/scenarios/<월드>/art/portraits/<id>.png
 *   (output_size 정사각형), 원본은 .cache/portraits/<월드>/<id>.png (git 제외)
 * - --style X: 그 화풍의 얼굴만
 * - framing이 있으면 얼굴을 찾아(SAM 3) 같은 크기·위치로 자르고, 여백이 모자라면 cleanup(Qwen Image 편집)으로 이어 채운다
 * - 1차로 모두 그린 뒤 2차로 정리·자르기를 한다 (모델을 덜 갈아 끼운다)
 * - --variants N: seed, seed+1, ... 로 N장을 .cache/portraits/<월드>/candidates/<id>/ 에만 만든다.
 *   마음에 드는 시드를 portraits.yaml에 적고 다시 돌리면 그 얼굴이 들어간다
 * - portraits.lock.json에 (화풍 + 공통 규칙 + 기준 색 그림 + 묘사 + 시드)의 해시를 남기고,
 *   해시가 같은 그림은 건너뛴다. 그래서 화풍을 바꾸면 전부, 한 캐릭터만 바꾸면 그 캐릭터만 다시 만든다
 * - ComfyUI 주소는 COMFYUI_URL (기본 http://127.0.0.1:8188)
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parse } from "yaml";

type Grade = { ref: string; strength: number; method?: string };
type Style = {
  label?: string;
  checkpoint: string;
  prompt: string;
  negative: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  grade?: Grade;
  /**
   * 색 입히기 지시 (Qwen 편집). colorize: true인 얼굴은 자른 뒤 이 지시로 색을 입힌다 (흑백 그림을 화풍의 컬러로 맞출 때)
   */
  colorize?: string;
  /** 이 화풍 전체의 자르는 영역 배율 (기본 1). 1보다 작으면 얼굴이 커진다. 얼굴의 crop_scale과 곱한다 */
  crop_scale?: number;
  /** 머리가 위로 잘리는 화풍용: 위쪽을 이만큼(px, 8의 배수) 이어 그린 뒤 위에서부터 정사각형으로 자른다 */
  extend_top?: number;
};
type Character = {
  style: string;
  gender: string;
  seed: number;
  subject: string;
  tags?: string;
  /** 그리지 않고 이 그림(art/ 안의 파일)을 원본으로 쓴다: 마음에 든 옛 그림을 그대로 살릴 때 */
  source?: string;
  /** 화풍의 색 보정 대신 이것을 쓴다 (톤만 바꿀 때) */
  grade?: Grade;
  /** 화풍의 colorize 지시로 색을 입힌다 (흑백·회색조로 그려진 그림) */
  colorize?: boolean;
  /** 마지막에 이 지시 하나만으로 Qwen 편집을 한 번 더 한다 (특정 부분만 고칠 때. 다른 지시와 섞으면 잘 안 먹힌다) */
  touchup?: string;
  /** 자르는 영역 배율 (기본 1). 고개를 돌려 얼굴 너비가 좁게 재지는 얼굴은 1보다 크게 (얼굴이 작아진다) */
  crop_scale?: number;
  /** 여백이 모자라지 않아도 정리(cleanup)를 한다: 원본에 액자·테두리가 그려진 그림. 글이면 정리 지시에 덧붙인다 */
  cleanup?: boolean | string;
};
/**
 * 정리 (Qwen Image 편집): 여백이 모자란 그림은 회색 여백을 붙여 장면을 이어 채우고,
 * 액자·비네트·흐려진 가장자리를 지운다. 인물은 그대로 두라고 지시한다
 */
type Cleanup = { unet: string; clip: string; vae: string; instruction: string; seed: number };
/** 얼굴 맞추기: 그린 뒤 얼굴을 찾아(SAM 3) 모든 초상화에서 얼굴 크기·위치가 같도록 자른다 */
type Framing = {
  /** ComfyUI checkpoints의 SAM 3 모델 */
  detector: string;
  /** 찾을 것 (SAM 3 글 프롬프트) */
  target: string;
  /**
   * 완성 그림에서 얼굴 상자 너비의 비율 (0~1): 모든 얼굴의 크기를 이것으로 맞춘다.
   * 상자 높이는 앞머리가 이마를 덮었는지에 따라 크게 달라져서 쓰지 않는다
   */
  face_width: number;
  /** 완성 그림에서 턱 끝(얼굴 상자 아래)의 세로 위치 (0 위 ~ 1 아래). 머리가 그림 위로 잘려도 흔들리지 않는다 */
  chin_y: number;
};
type Config = {
  output_size: number;
  framing?: Framing;
  cleanup?: Cleanup;
  common?: { prompt?: string; negative?: string };
  styles: Record<string, Style>;
  faces: Record<string, Character>;
};

const COMFY = process.env.COMFYUI_URL ?? "http://127.0.0.1:8188";
const ROOT = resolve(import.meta.dirname, "..");

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    style: { type: "string" },
    only: { type: "string" },
    force: { type: "boolean", default: false },
    variants: { type: "string" },
    dry: { type: "boolean", default: false },
    /** 기준 맞추기용: 캐시의 원본에서 얼굴 상자의 비율을 잰다 (예: --measure a_f1,d_f1) */
    measure: { type: "string" },
  },
});

const world = positionals[0];
if (!world) fail("월드 id를 주세요. 예: pnpm portraits post_apoc");

const artDir = join(ROOT, "content/scenarios", world, "art");
const configPath = join(artDir, "portraits.yaml");
if (!existsSync(configPath)) fail(`${configPath} 가 없습니다`);
const config = parse(readFileSync(configPath, "utf8")) as Config;
validate(config);

if (opts.style && !config.styles[opts.style]) fail(`없는 화풍: ${opts.style} (있는 것: ${Object.keys(config.styles).join(", ")})`);

const cacheDir = join(ROOT, ".cache/portraits", world);
const outDir = join(artDir, "portraits");
const lockPath = join(artDir, "portraits.lock.json");
const lock: Record<string, string> = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, "utf8")) : {};

const only = opts.only ? new Set(opts.only.split(",").map((s) => s.trim())) : null;
if (only) for (const id of only) if (!config.faces[id]) fail(`portraits.yaml에 없는 id: ${id}`);
// 화풍끼리 모아서 그린다 (모델을 덜 갈아 끼운다)
const styleOrder = Object.keys(config.styles);
const ids = Object.keys(config.faces)
  .filter((id) => (!only || only.has(id)) && (!opts.style || config.faces[id].style === opts.style))
  .sort((a, b) => styleOrder.indexOf(config.faces[a].style) - styleOrder.indexOf(config.faces[b].style));
const variants = opts.variants ? Number(opts.variants) : 0;
if (opts.variants && !(Number.isInteger(variants) && variants > 0)) fail("--variants는 1 이상의 정수");

const framing = config.framing;
if (opts.measure) {
  if (!framing) fail("portraits.yaml에 framing이 없습니다");
  await checkServer(new Set([framing.detector]), null);
  for (const id of opts.measure.split(",").map((x) => x.trim())) {
    const path = join(ROOT, ".cache/portraits", world, `${id}.png`);
    if (!existsSync(path)) fail(`${path} 가 없습니다`);
    const { width, height } = pngSize(readFileSync(path));
    const name = await upload(readFileSync(path), `trpg_measure_${id}.png`);
    const face = await detectFace({ img: { class_type: "LoadImage", inputs: { image: name } } }, ["img", 0]);
    if (!face) {
      console.log(`${id}: 얼굴을 찾지 못했습니다`);
      continue;
    }
    const side = Math.min(width, height);
    console.log(`${id}: face_width ${(face.width / side).toFixed(3)} chin_y ${((face.y + face.height) / side).toFixed(3)} (box ${face.x.toFixed(0)},${face.y.toFixed(0)} ${face.width.toFixed(0)}x${face.height.toFixed(0)} / ${width}x${height})`);
  }
  process.exit(0);
}

const cleanup = config.cleanup;
const needed = new Set(ids.filter((id) => !config.faces[id].source).map((id) => config.styles[config.faces[id].style].checkpoint));
if (framing) needed.add(framing.detector);
if (!opts.dry) await checkServer(needed, cleanup ? { unet: cleanup.unet, clip: cleanup.clip, vae: cleanup.vae } : null);

// 지금 다루는 화풍 (promptFor·workflow가 쓴다)
let style: Style = undefined as unknown as Style;

type Job = { id: string; ch: Character; prefix: string; dest: string; hash?: string; raw?: Buffer; crop?: Crop | null; t0?: number };
const jobs: Job[] = [];
for (const id of ids) {
  const ch = config.faces[id];
  if (variants) {
    if (ch.source) continue;
    for (let i = 0; i < variants; i++) {
      const seed = ch.seed + i;
      const dest = join(cacheDir, "candidates", id, `${seed}.png`);
      if (!opts.force && existsSync(dest)) continue;
      jobs.push({ id, ch: { ...ch, seed }, prefix: `${id}_${seed}`, dest });
    }
    continue;
  }
  const hash = hashOf(ch);
  const dest = join(outDir, `${id}.png`);
  if (!opts.force && existsSync(dest) && lock[id] === hash) continue;
  jobs.push({ id, ch, prefix: id, dest, hash });
}
for (const job of jobs) console.error(`${job.prefix} seed=${job.ch.seed}${job.ch.source ? ` (원본 ${job.ch.source})` : ""}`);
if (opts.dry || !jobs.length) {
  if (!jobs.length) console.error("새로 만들 그림이 없습니다 (--force로 다시 만들기)");
  process.exit(0);
}

// 1차: 모두 그리고(또는 원본을 읽고) 얼굴을 찾는다. 화풍끼리 모여 있어 모델을 덜 갈아 끼운다
console.error(`1차: 그리기 ${jobs.length}장`);
for (const job of jobs) {
  style = config.styles[job.ch.style];
  job.t0 = Date.now();
  let face: Box | null = null;
  if (job.ch.source) {
    job.raw = readFileSync(join(artDir, job.ch.source));
    if (framing) {
      const name = await upload(job.raw, `trpg_src_${job.id}.png`);
      face = await detectFace({ img: { class_type: "LoadImage", inputs: { image: name } } }, ["img", 0]);
    }
  } else {
    const first = await run(generateWorkflow(job.ch, job.prefix));
    job.raw = await fetchImg(first, "save_raw");
    if (framing) face = parseFace(first);
  }
  job.crop = null;
  if (framing) {
    const { width, height } = pngSize(job.raw);
    if (face) job.crop = planCrop(face, width, height, (style.crop_scale ?? 1) * (job.ch.crop_scale ?? 1));
    else console.error(`  ! ${job.prefix}: 얼굴을 찾지 못해 가운데를 자릅니다`);
  }
  const p = job.crop?.pad;
  const padded = p ? p.left + p.top + p.right + p.bottom > 0 : false;
  console.error(`  ${job.prefix}: ${((Date.now() - job.t0) / 1000).toFixed(0)}초${padded ? ` · 여백 모자람 (왼${p!.left} 위${p!.top} 오${p!.right} 아래${p!.bottom}px)` : ""}${job.ch.cleanup ? " · 정리 지정" : ""}`);
}

// 2차: (정리) → 자르기 → 색 보정 → 줄이기
console.error("2차: 정리·자르기");
let made = 0;
for (const job of jobs) {
  style = config.styles[job.ch.style];
  const t0 = Date.now();
  const rawName = await upload(job.raw!, `trpg_raw_${job.prefix}.png`);
  const second = await run(await finishWorkflow(rawName, pngSize(job.raw!), job.crop ?? null, job.ch, job.prefix));
  const small = await fetchImg(second, "save_small");
  mkdirSync(dirname(job.dest), { recursive: true });
  writeFileSync(job.dest, small);
  if (job.hash) {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, `${job.id}.png`), job.raw!);
    lock[job.id] = job.hash;
    writeFileSync(lockPath, JSON.stringify(sortKeys(lock), null, 2) + "\n");
  }
  console.error(`  ${job.prefix}: ${((Date.now() - t0) / 1000).toFixed(0)}초`);
  made++;
}
console.error(`${made}장 만들었습니다 → ${variants ? join(cacheDir, "candidates") : outDir}`);

/** 설정 해시: 이 그림에 영향을 주는 것 전부 (화풍, 공통 규칙, 얼굴 맞추기, 정리, 색 기준 그림, 원본 그림, 얼굴 설정) */
function hashOf(ch: Character): string {
  const st = config.styles[ch.style];
  const grade = ch.grade ?? st.grade;
  const fileHash = (f?: string) => (f && existsSync(join(artDir, f)) ? sha(readFileSync(join(artDir, f))) : null);
  return sha(
    JSON.stringify({
      style: st, common: config.common, framing, cleanup: config.cleanup, size: config.output_size, ch,
      grade: grade ? { ...grade, file: fileHash(grade.ref) } : null, source: fileHash(ch.source),
    }),
  );
}

// ---------------------------------------------------------------------------

function promptFor(ch: Character): { pos: string; neg: string } {
  const join2 = (...xs: (string | undefined)[]) => xs.map((x) => x?.trim()).filter(Boolean).join(", ");
  const pos = style.prompt.replaceAll("{subject}", ch.subject.trim()).replaceAll("{tags}", ch.tags?.trim() ?? "");
  return { pos: join2(pos.replace(/^[,\s]+/, ""), config.common?.prompt), neg: join2(style.negative, config.common?.negative) };
}

type Node = { class_type: string; inputs: Record<string, unknown> };
type Box = { x: number; y: number; width: number; height: number; score?: number };

/** 1단계 워크플로: 생성 (+ 위쪽 이어 그리기) → 원본 저장. framing이 있으면 얼굴 상자도 찾는다 */
function generateWorkflow(ch: Character, prefix: string) {
  const { pos, neg } = promptFor(ch);
  const wf: Record<string, Node> = {
    ckpt: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: style.checkpoint } },
    latent: { class_type: "EmptyLatentImage", inputs: { width: style.width, height: style.height, batch_size: 1 } },
    pos: { class_type: "CLIPTextEncode", inputs: { clip: ["ckpt", 1], text: pos } },
    neg: { class_type: "CLIPTextEncode", inputs: { clip: ["ckpt", 1], text: neg } },
    sample: {
      class_type: "KSampler",
      inputs: {
        model: ["ckpt", 0], positive: ["pos", 0], negative: ["neg", 0], latent_image: ["latent", 0],
        seed: ch.seed, steps: style.steps, cfg: style.cfg,
        sampler_name: style.sampler, scheduler: style.scheduler, denoise: 1,
      },
    },
    decode: { class_type: "VAEDecode", inputs: { samples: ["sample", 0], vae: ["ckpt", 2] } },
  };
  let image: [string, number] = ["decode", 0];
  if (style.extend_top) {
    // 머리가 위로 잘리는 화풍: 그림 위쪽을 extend_top만큼 이어 그린다(아웃페인팅).
    // 얼굴 맞추기가 없으면 위에서부터 정사각형으로 자른다 (있으면 얼굴 기준으로 자른다)
    wf.pad = { class_type: "ImagePadForOutpaint", inputs: { image, left: 0, top: style.extend_top, right: 0, bottom: 0, feathering: 64 } };
    wf.pad_latent = { class_type: "VAEEncodeForInpaint", inputs: { pixels: ["pad", 0], vae: ["ckpt", 2], mask: ["pad", 1], grow_mask_by: 8 } };
    wf.pad_sample = { class_type: "KSampler", inputs: { ...wf.sample.inputs, latent_image: ["pad_latent", 0] } };
    wf.pad_decode = { class_type: "VAEDecode", inputs: { samples: ["pad_sample", 0], vae: ["ckpt", 2] } };
    image = ["pad_decode", 0];
    if (!framing) {
      const side = Math.min(style.width, style.height + style.extend_top);
      wf.pad_crop = { class_type: "ImageCrop", inputs: { image, width: side, height: side, x: 0, y: 0 } };
      image = ["pad_crop", 0];
    }
  }
  wf.save_raw = { class_type: "SaveImage", inputs: { images: image, filename_prefix: `trpg/${prefix}_raw` } };
  if (framing) Object.assign(wf, detectNodes(image));
  return wf;
}

/** 얼굴 찾기 노드들 (SAM 3, 글 프롬프트). 결과 상자는 PreviewAny의 글로 받는다 */
function detectNodes(image: [string, number]): Record<string, Node> {
  return {
    det_ckpt: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: framing!.detector } },
    det_text: { class_type: "CLIPTextEncode", inputs: { clip: ["det_ckpt", 1], text: framing!.target } },
    det: {
      class_type: "SAM3_Detect",
      inputs: { model: ["det_ckpt", 0], image, conditioning: ["det_text", 0], threshold: 0.3, refine_iterations: 0, individual_masks: false },
    },
    det_out: { class_type: "PreviewAny", inputs: { source: ["det", 1] } },
  };
}

/** 2단계 워크플로: 원본에서 (정리하고) 정사각형을 잘라 (색 보정) → output_size로 줄여 저장 */
async function finishWorkflow(rawName: string, size: { width: number; height: number }, crop: Crop | null, ch: Character, prefix: string) {
  const wf: Record<string, Node> = { raw: { class_type: "LoadImage", inputs: { image: rawName } } };
  let image: [string, number] = ["raw", 0];
  const pad = crop?.pad;
  const padded = !!pad && pad.left + pad.top + pad.right + pad.bottom > 0;
  const colorizeHere = !!(ch.colorize && style.colorize && cleanup);
  let colorized = false;
  if (cleanup && (padded || ch.cleanup)) {
    // Qwen 편집: 회색 여백을 붙인 그림을 주고 장면을 이어 채우게 한다. 인물은 그대로 두라고 지시한다
    if (padded) {
      wf.pad = { class_type: "ImagePadForOutpaint", inputs: { image, ...pad, feathering: 0 } };
      image = ["pad", 0];
    }
    Object.assign(wf, {
      q_unet: { class_type: "UNETLoader", inputs: { unet_name: cleanup.unet, weight_dtype: "default" } },
      q_cache: { class_type: "QwenImage21Cache", inputs: { model: ["q_unet", 0], device: "auto", dtype: "default" } },
      q_clip: { class_type: "CLIPLoader", inputs: { clip_name: cleanup.clip, type: "qwen_image", device: "default" } },
      q_vae: { class_type: "VAELoader", inputs: { vae_name: cleanup.vae } },
      q_enc: {
        class_type: "TextEncodeQwenImage21",
        inputs: { clip: ["q_clip", 0], vae: ["q_vae", 0], prompt: [cleanup.instruction.trim(), typeof ch.cleanup === "string" ? ch.cleanup.trim() : "", colorizeHere ? style.colorize!.trim() : ""].filter(Boolean).join(" "), negative_prompt: "", resolution: 1024, "images.image_1": image },
      },
      q_guider: { class_type: "CFGGuider", inputs: { model: ["q_cache", 0], positive: ["q_enc", 0], negative: ["q_enc", 1], cfg: 1 } },
      q_noise: { class_type: "RandomNoise", inputs: { noise_seed: cleanup.seed } },
      q_sampler: { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
      q_sigmas: { class_type: "ManualSigmas", inputs: { sigmas: "1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0" } },
      q_sample: {
        class_type: "SamplerCustomAdvanced",
        inputs: { noise: ["q_noise", 0], guider: ["q_guider", 0], sampler: ["q_sampler", 0], sigmas: ["q_sigmas", 0], latent_image: ["q_enc", 2] },
      },
      q_decode: { class_type: "VAEDecode", inputs: { samples: ["q_sample", 0], vae: ["q_vae", 0] } },
      // Qwen VAE는 알파 채널이 붙은 4채널을 낸다: RGB만 남긴다
      q_rgb: { class_type: "SplitImageWithAlpha", inputs: { image: ["q_decode", 0] } },
    });
    // Qwen은 약 1메가픽셀로 작업한다 (큰 캔버스도 빠르게). 결과를 넓힌 캔버스 크기로 되돌린다
    const W = size.width + (padded ? pad!.left + pad!.right : 0);
    const H = size.height + (padded ? pad!.top + pad!.bottom : 0);
    wf.q_size = { class_type: "ImageScale", inputs: { image: ["q_rgb", 0], upscale_method: "lanczos", width: W, height: H, crop: "disabled" } };
    image = ["q_size", 0];
    // 색 입히기를 이 편집에 함께 실었다 (Qwen을 한 번만 돌린다)
    colorized = colorizeHere;
    // 원본 안쪽을 고치라는 지시(ch.cleanup)가 없으면, 원래 그림 자리는 원본 픽셀로 다시 덮는다 (Qwen이 인물을 바꾸지 못하게).
    // 이어 채운 쪽 경계만 부드럽게 섞는다
    // 색 입히기를 함께 했으면 원본(흑백)으로 덮으면 색이 지워진다: 덮지 않는다
    if (padded && !ch.cleanup && !colorizeHere) {
      const feather = 48;
      wf.keep_mask = { class_type: "SolidMask", inputs: { value: 1, width: size.width, height: size.height } };
      wf.keep_feather = {
        class_type: "FeatherMask",
        inputs: {
          mask: ["keep_mask", 0],
          left: pad!.left ? feather : 0, top: pad!.top ? feather : 0, right: pad!.right ? feather : 0, bottom: pad!.bottom ? feather : 0,
        },
      };
      wf.keep_paste = {
        class_type: "ImageCompositeMasked",
        inputs: { destination: image, source: ["raw", 0], x: pad!.left, y: pad!.top, resize_source: false, mask: ["keep_feather", 0] },
      };
      image = ["keep_paste", 0];
    }
  } else if (padded) {
    // 자를 자리가 그림 밖으로 나간다: 그만큼 캔버스를 넓혀 같은 모델·프롬프트로 이어 그린다
    const { pos, neg } = promptFor(ch);
    Object.assign(wf, {
      ckpt: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: style.checkpoint } },
      pos: { class_type: "CLIPTextEncode", inputs: { clip: ["ckpt", 1], text: pos } },
      neg: { class_type: "CLIPTextEncode", inputs: { clip: ["ckpt", 1], text: neg } },
      pad: { class_type: "ImagePadForOutpaint", inputs: { image, ...pad, feathering: 64 } },
      pad_latent: { class_type: "VAEEncodeForInpaint", inputs: { pixels: ["pad", 0], vae: ["ckpt", 2], mask: ["pad", 1], grow_mask_by: 8 } },
      pad_sample: {
        class_type: "KSampler",
        inputs: {
          model: ["ckpt", 0], positive: ["pos", 0], negative: ["neg", 0], latent_image: ["pad_latent", 0],
          seed: ch.seed, steps: style.steps, cfg: style.cfg, sampler_name: style.sampler, scheduler: style.scheduler, denoise: 1,
        },
      },
      pad_decode: { class_type: "VAEDecode", inputs: { samples: ["pad_sample", 0], vae: ["ckpt", 2] } },
    });
    image = ["pad_decode", 0];
  }
  if (crop) {
    wf.crop = { class_type: "ImageCrop", inputs: { image, width: crop.side, height: crop.side, x: crop.x, y: crop.y } };
    image = ["crop", 0];
  }
  if (colorizeHere && !colorized) {
    // 자른 그림에 색을 입힌다 (Qwen 편집, 약 1메가픽셀). 결과를 자른 크기로 되돌린다
    Object.assign(wf, {
      col_unet: { class_type: "UNETLoader", inputs: { unet_name: cleanup.unet, weight_dtype: "default" } },
      col_cache: { class_type: "QwenImage21Cache", inputs: { model: ["col_unet", 0], device: "auto", dtype: "default" } },
      col_clip: { class_type: "CLIPLoader", inputs: { clip_name: cleanup.clip, type: "qwen_image", device: "default" } },
      col_vae: { class_type: "VAELoader", inputs: { vae_name: cleanup.vae } },
      col_enc: {
        class_type: "TextEncodeQwenImage21",
        inputs: { clip: ["col_clip", 0], vae: ["col_vae", 0], prompt: style.colorize!.trim(), negative_prompt: "", resolution: 1024, "images.image_1": image },
      },
      col_guider: { class_type: "CFGGuider", inputs: { model: ["col_cache", 0], positive: ["col_enc", 0], negative: ["col_enc", 1], cfg: 1 } },
      col_noise: { class_type: "RandomNoise", inputs: { noise_seed: cleanup.seed } },
      col_sampler: { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
      col_sigmas: { class_type: "ManualSigmas", inputs: { sigmas: "1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0" } },
      col_sample: {
        class_type: "SamplerCustomAdvanced",
        inputs: { noise: ["col_noise", 0], guider: ["col_guider", 0], sampler: ["col_sampler", 0], sigmas: ["col_sigmas", 0], latent_image: ["col_enc", 2] },
      },
      col_decode: { class_type: "VAEDecode", inputs: { samples: ["col_sample", 0], vae: ["col_vae", 0] } },
      col_rgb: { class_type: "SplitImageWithAlpha", inputs: { image: ["col_decode", 0] } },
    });
    image = ["col_rgb", 0];
  }
  if (ch.touchup && cleanup) {
    // 특정 부분 고치기: 이 지시만으로 한 번 더 편집한다
    Object.assign(wf, qwenEdit("tu", image, ch.touchup.trim()));
    image = ["tu_rgb", 0];
  }
  if (ch.colorize && !colorizeHere) console.error(`  ! ${prefix}: colorize는 화풍의 colorize 지시와 cleanup 모델이 있어야 합니다`);
  const grade = ch.grade ?? style.grade;
  const gradeRef = grade ? join(artDir, grade.ref) : null;
  if (grade && gradeRef && existsSync(gradeRef)) {
    wf.ref = { class_type: "LoadImage", inputs: { image: await uploadRef(gradeRef) } };
    wf.grade = {
      class_type: "ColorTransfer",
      inputs: {
        image_target: image, image_ref: ["ref", 0],
        method: grade.method ?? "reinhard_lab", source_stats: "per_frame", strength: grade.strength,
      },
    };
    image = ["grade", 0];
  } else if (grade) console.error(`  ! 색 기준 그림 ${grade.ref} 가 없어 색 보정 없이 만듭니다`);
  wf.scale = {
    class_type: "ImageScale",
    inputs: { image, upscale_method: "lanczos", width: config.output_size, height: config.output_size, crop: "center" },
  };
  wf.save_small = { class_type: "SaveImage", inputs: { images: ["scale", 0], filename_prefix: `trpg/${prefix}_small` } };
  return wf;
}

type Crop = { x: number; y: number; side: number; pad: { left: number; top: number; right: number; bottom: number } };

/**
 * 얼굴 상자로 자를 정사각형: 얼굴 너비가 face_width, 얼굴이 가로 가운데, 턱 끝이 chin_y에 오게.
 * 그림 밖으로 나가는 만큼 pad를 돌려준다: 그만큼 캔버스를 넓혀 이어 채운 뒤 자른다
 */
function planCrop(face: Box, width: number, height: number, scale: number): Crop {
  const f = framing!;
  // 크기는 얼굴 너비, 세로 위치는 턱 끝으로 맞춘다 (머리숱·앞머리에 덜 흔들린다. 머리카락은 조금 잘려도 된다)
  const side = Math.round((face.width / f.face_width) * scale);
  const x = Math.round(face.x + face.width / 2 - side / 2);
  const y = Math.round(face.y + face.height - f.chin_y * side);
  const need = { left: -x, top: -y, right: x + side - width, bottom: y + side - height };
  // 조금만 모자라면(한 변의 4% 이하) 이어 그리지 않고 자를 자리를 안쪽으로 민다
  if (side <= Math.min(width, height) && Math.max(...Object.values(need)) <= side * 0.04) {
    return { x: Math.min(Math.max(x, 0), width - side), y: Math.min(Math.max(y, 0), height - side), side, pad: { left: 0, top: 0, right: 0, bottom: 0 } };
  }
  // Qwen 편집은 32의 배수 크기를 그대로 돌려준다 (SDXL 이어 그리기는 8의 배수면 된다)
  const unit = cleanup ? 32 : 8;
  const up = (n: number) => (n > 0 ? Math.ceil(n / unit) * unit : 0);
  const pad = { left: up(need.left), top: up(need.top), right: up(need.right), bottom: up(need.bottom) };
  return { x: x + pad.left, y: y + pad.top, side, pad };
}

/** 이미 있는 그림에서 얼굴 상자를 찾는다 */
async function detectFace(source: Record<string, Node>, image: [string, number]): Promise<Box | null> {
  return parseFace(await run({ ...source, ...detectNodes(image) }));
}

type Img = { filename: string; subfolder: string; type: string };
type Entry = { status?: { status_str?: string; messages?: unknown }; outputs: Record<string, { images?: Img[]; text?: string[] }> };

async function run(wf: Record<string, Node>): Promise<Entry> {
  const res = await fetch(`${COMFY}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: wf }),
  });
  const body = (await res.json()) as { prompt_id?: string; error?: unknown; node_errors?: unknown };
  if (!res.ok || !body.prompt_id) fail(`ComfyUI가 작업을 거절했습니다: ${JSON.stringify({ error: body.error, node_errors: body.node_errors })}`);
  const promptId = body.prompt_id;
  for (;;) {
    const hist = (await (await fetch(`${COMFY}/history/${promptId}`)).json()) as Record<string, Entry>;
    const entry = hist[promptId];
    if (entry?.status?.status_str === "error") fail(`생성 실패: ${JSON.stringify(entry.status.messages).slice(0, 2000)}`);
    if (entry?.status?.status_str === "success") return entry;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function fetchImg(entry: Entry, node: string): Promise<Buffer> {
  const img = entry.outputs[node]?.images?.[0];
  if (!img) fail(`${node} 출력이 없습니다`);
  const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder, type: img.type });
  return Buffer.from(await (await fetch(`${COMFY}/view?${q}`)).arrayBuffer());
}

/** SAM 3 결과(프레임마다 상자 목록)에서 가장 확실한 얼굴 하나 */
function parseFace(entry: Entry): Box | null {
  const text = entry.outputs.det_out?.text?.[0];
  if (!text) return null;
  const parsed = JSON.parse(text) as Box[][] | Box[];
  const boxes = (Array.isArray(parsed[0]) ? (parsed as Box[][]).flat() : (parsed as Box[])).filter((b) => b && b.height > 0);
  if (!boxes.length) return null;
  return boxes.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0]!;
}

/** PNG 머리에서 크기를 읽는다 */
function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** 색 기준 그림을 ComfyUI input 폴더에 올린다. 내용 해시를 이름에 넣어 바뀌면 새 파일로 올라간다 */
async function uploadRef(path: string): Promise<string> {
  const data = readFileSync(path);
  return upload(data, `trpg_${sha(data)}_${basename(path)}`);
}

async function upload(data: Buffer, name: string): Promise<string> {
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(data)], { type: "image/png" }), name);
  form.append("overwrite", "true");
  const res = await fetch(`${COMFY}/upload/image`, { method: "POST", body: form });
  if (!res.ok) fail(`그림을 ComfyUI에 올리지 못했습니다: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { name: string }).name;
}

async function checkServer(needed: Set<string>, qwen: { unet: string; clip: string; vae: string } | null) {
  let ckpts: string[];
  try {
    const res = await fetch(`${COMFY}/object_info/CheckpointLoaderSimple`);
    const info = (await res.json()) as Record<string, { input: { required: { ckpt_name: [string[]] } } }>;
    ckpts = info.CheckpointLoaderSimple.input.required.ckpt_name[0];
  } catch {
    fail(`ComfyUI(${COMFY})에 연결할 수 없습니다. 서버를 먼저 띄워 주세요: cd ~/dev/ComfyUI && .venv/bin/python main.py`);
  }
  const missing = [...needed].filter((c) => !ckpts.includes(c));
  if (missing.length) fail(`ComfyUI에 체크포인트 ${missing.join(", ")} 가 없습니다. 있는 것: ${ckpts.join(", ") || "(없음)"}`);
  if (qwen) {
    const list = async (node: string, field: string) => {
      const info = (await (await fetch(`${COMFY}/object_info/${node}`)).json()) as Record<string, { input: { required: Record<string, [string[]]> } }>;
      return info[node]!.input.required[field]![0];
    };
    const lacks = [
      ...((await list("UNETLoader", "unet_name")).includes(qwen.unet) ? [] : [qwen.unet]),
      ...((await list("CLIPLoader", "clip_name")).includes(qwen.clip) ? [] : [qwen.clip]),
      ...((await list("VAELoader", "vae_name")).includes(qwen.vae) ? [] : [qwen.vae]),
    ];
    if (lacks.length) fail(`정리(cleanup)에 쓸 Qwen 모델이 ComfyUI에 없습니다: ${lacks.join(", ")}`);
  }
}

function validate(c: Config) {
  if (!c?.styles || typeof c.styles !== "object") fail("portraits.yaml에 styles가 없습니다");
  if (typeof c.output_size !== "number") fail("output_size는 숫자여야 합니다");
  for (const [sid, s] of Object.entries(c.styles)) {
    for (const k of ["checkpoint", "prompt", "negative", "sampler", "scheduler"] as const) {
      if (typeof s[k] !== "string" || !s[k]) fail(`styles.${sid}.${k}는 문자열이어야 합니다`);
    }
    for (const k of ["width", "height", "steps", "cfg"] as const) {
      if (typeof s[k] !== "number") fail(`styles.${sid}.${k}는 숫자여야 합니다`);
    }
    if (!s.prompt.includes("{subject}")) fail(`styles.${sid}.prompt에 {subject} 자리가 있어야 합니다`);
    if (s.extend_top !== undefined && !(Number.isInteger(s.extend_top) && s.extend_top > 0 && s.extend_top % 8 === 0)) {
      fail(`styles.${sid}.extend_top은 8의 배수인 양의 정수여야 합니다`);
    }
    if (s.grade && (typeof s.grade.ref !== "string" || typeof s.grade.strength !== "number")) {
      fail(`styles.${sid}.grade에는 ref(파일 이름)와 strength(0~1)가 필요합니다`);
    }
  }
  if (c.framing) {
    const f = c.framing;
    if (typeof f.detector !== "string" || typeof f.target !== "string") fail("framing에는 detector(모델 파일)와 target(찾을 것)이 필요합니다");
    if (![f.face_width, f.chin_y].every((v) => v > 0 && v < 1)) fail("framing.face_width·chin_y는 0~1 사이");
  }
  if (c.cleanup && !["unet", "clip", "vae", "instruction"].every((k) => typeof (c.cleanup as Record<string, unknown>)[k] === "string")) {
    fail("cleanup에는 unet·clip·vae(모델 파일)와 instruction(편집 지시)이 필요합니다");
  }
  for (const [id, ch] of Object.entries(c.faces ?? {})) {
    if (ch?.source && !existsSync(join(artDir, ch.source))) fail(`faces.${id}.source: ${ch.source} 가 없습니다`);
    if (ch?.crop_scale !== undefined && !(ch.crop_scale > 0.5 && ch.crop_scale < 2)) fail(`faces.${id}.crop_scale은 0.5~2 사이`);
    if (!/^[a-z0-9_-]{1,40}$/.test(id)) fail(`faces.${id}: id는 영문 소문자·숫자·_·-만 (40자까지)`);
    if (!c.styles[ch?.style]) fail(`faces.${id}: 없는 화풍 ${ch?.style}`);
    if (typeof ch.gender !== "string") fail(`faces.${id}에 gender가 필요합니다`);
    if (!Number.isInteger(ch.seed) || typeof ch.subject !== "string") fail(`faces.${id}에 seed(정수)와 subject(문자열)가 필요합니다`);
  }
}

function sha(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}

function sortKeys(o: Record<string, string>) {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** Qwen Image 편집 노드들 (이름 앞에 prefix). 결과는 <prefix>_rgb */
function qwenEdit(prefix: string, image: [string, number], prompt: string): Record<string, Node> {
  const c = cleanup!;
  const n = (k: string) => `${prefix}_${k}`;
  return {
    [n("unet")]: { class_type: "UNETLoader", inputs: { unet_name: c.unet, weight_dtype: "default" } },
    [n("cache")]: { class_type: "QwenImage21Cache", inputs: { model: [n("unet"), 0], device: "auto", dtype: "default" } },
    [n("clip")]: { class_type: "CLIPLoader", inputs: { clip_name: c.clip, type: "qwen_image", device: "default" } },
    [n("vae")]: { class_type: "VAELoader", inputs: { vae_name: c.vae } },
    [n("enc")]: {
      class_type: "TextEncodeQwenImage21",
      inputs: { clip: [n("clip"), 0], vae: [n("vae"), 0], prompt, negative_prompt: "", resolution: 1024, "images.image_1": image },
    },
    [n("guider")]: { class_type: "CFGGuider", inputs: { model: [n("cache"), 0], positive: [n("enc"), 0], negative: [n("enc"), 1], cfg: 1 } },
    [n("noise")]: { class_type: "RandomNoise", inputs: { noise_seed: c.seed } },
    [n("sampler")]: { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
    [n("sigmas")]: { class_type: "ManualSigmas", inputs: { sigmas: "1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0" } },
    [n("sample")]: {
      class_type: "SamplerCustomAdvanced",
      inputs: { noise: [n("noise"), 0], guider: [n("guider"), 0], sampler: [n("sampler"), 0], sigmas: [n("sigmas"), 0], latent_image: [n("enc"), 2] },
    },
    [n("decode")]: { class_type: "VAEDecode", inputs: { samples: [n("sample"), 0], vae: [n("vae"), 0] } },
    [n("rgb")]: { class_type: "SplitImageWithAlpha", inputs: { image: [n("decode"), 0] } },
  };
}
