# 주인공 초상화 만들기

주인공 얼굴 그림(캐릭터 생성의 얼굴 고르기)을 로컬 ComfyUI로 만드는 방법이다. 게임 규칙은 `docs/design.md` 12-139, 설정 칸의 뜻은 `content/scenarios/post_apoc/art/portraits.yaml` 머리 주석에 있다. 이 문서는 **작업하는 순서와 겪어 본 함정**만 적는다.

## 준비

- ComfyUI: `~/dev/ComfyUI` (가상환경 `.venv`). 띄우기:
  ```bash
  cd ~/dev/ComfyUI && .venv/bin/python main.py --listen 127.0.0.1 --port 8188
  ```
- 쓰는 모델 (ComfyUI `models/` 아래)
  - 그리기: SDXL Base 1.0 (`sd_xl_base_1.0.safetensors`)
  - 얼굴 찾기: SAM 3.1 (`sam3.1_multiplex_fp16.safetensors`)
  - 정리·색 입히기·손보기: Qwen Image 2.1 Turbo 편집 (unet·clip·vae는 yaml의 `cleanup`)
  - ※ Qwen Image 2.1은 Qwen RESEARCH LICENSE(비상업·연구/평가용)다. 배포·판매 전에 라이선스를 다시 확인한다
- 주소를 바꾸려면 `COMFYUI_URL`

## 한 장 만드는 데 걸리는 시간

M 시리즈 맥 기준으로 그리기 1.5~2분 + 정리·자르기 4~5분, 손보기(touchup)가 있으면 한 번에 2~3분 더. 8장이면 50분 남짓이다. 여러 장은 백그라운드로 돌린다.

## 순서

1. **묘사 쓰기**: `portraits.yaml`의 `faces`에 새 id(`d_f47`, `d_m47`처럼 이어서), `style: D`, `gender`, `seed`, `colorize: true`, 영어 `subject`를 적는다. 시드는 이전 얼굴과 겹치지 않게 10씩 띄운다.
2. **후보 뽑기** (권장): 한 묘사로 시드를 바꿔 여러 장을 본다. 결과는 `.cache/portraits/post_apoc/candidates/<id>/<seed>.png`에만 생긴다.
   ```bash
   pnpm portraits post_apoc --only d_f47,d_f48 --variants 3
   ```
   바로 완성본을 만들려면 `--variants` 없이 `--only`만.
3. **후보 고르기**: 마음에 든 시드를 yaml의 `seed`에 적고, 다시 그리지 않고 그 후보를 완성본으로 삼는다.
   ```bash
   pnpm portraits post_apoc --adopt d_f47:d_f47
   ```
   다른 id의 후보를 새 얼굴로 살릴 때는 `--adopt 새id:후보id`. 이때 새 얼굴의 `subject`는 **후보를 뽑을 때의 묘사와 같아야** 나중에 다시 그려도 같은 그림이 나온다.
4. **얼굴 크기 맞추기** (아래 "얼굴 크기"): 완성본을 바로 당겨 자른다. 몇 초면 된다.
   ```bash
   pnpm portraits post_apoc --zoom d_f47:1.15,d_f48:1.1
   ```
5. **확인**: `pnpm portraits post_apoc --dry`가 "새로 만들 그림이 없습니다"면 yaml·잠금 파일·그림이 맞물려 있다. 상태 화면의 새 게임에서 성별을 고르면 얼굴 목록이 보인다 (서버는 시작할 때 목록을 읽으니 다시 띄운다).

## 얼굴 크기

- 기준 얼굴: 남자 `d_m21`, 여자 `d_f21`·`d_f28`·`d_f31`. 완성본(256px)에서 잰 얼굴 상자가 남자 약 104×117, 여자 약 84×112px이다.
- 새 얼굴은 대개 작게 나온다. 잰 상자(너비 w, 높이 h)로 배율을 정한다: `zoom = √((기준w / w) × (기준h / h))`. 높이는 앞머리에 따라 흔들려서 너비와 섞어 쓴다.
- 재기: `pnpm portraits post_apoc --boxes` (기록이 없는 완성본만 잰다. 다시 재려면 `.cache/portraits/post_apoc/boxes.json`에서 그 id를 지운다)
- `--zoom`은 완성본을 **키우기만** 한다. 얼굴이 너무 크게 그려진 그림은 줄일 수 없다. `crop_scale`을 올려 다시 그려도 그리기 단계에서 얼굴을 엉뚱하게 잡으면 안 줄어든다. 그럴 땐 시드를 바꿔 다시 뽑는 편이 빠르다 (`d_m41`).
- 뚱뚱한 얼굴은 너비가 원래 넓다. 숫자보다 기준 얼굴 옆에 놓고 눈으로 본다.

## 손보기 (touchup)

- 머리 모양 한 군데, 눈 하나처럼 **한 가지만** 고칠 때 쓴다. 정리 지시에 섞으면 잘 안 먹는다.
- 고칠 것이 여럿이면 목록으로 적어 차례로 편집한다 (`d_f35`: 포니테일 → 앞머리 → 얼굴).
- 편집을 거듭할수록 얼굴에 점·잔선이 쌓인다. 얼굴을 바꾸는 편집은 **마지막**에 두고 "깨끗한 피부"를 함께 지시한다.
- 지시에는 "나머지는 그대로 둔다"를 꼭 붙인다.
- 직접 손본 그림을 완성본으로 쓸 때는 그 파일을 `art/portraits/<id>.png`에 덮어쓰고 yaml에 주석을 남긴다. 설정을 바꾸거나 `--force`로 다시 그리면 손질이 사라진다 (`d_f35`).

## 묘사 요령

- 10대는 "a young korean teenage girl/boy of about sixteen with a clearly childlike youthful face, soft round cheeks"처럼 어린 얼굴을 분명히 적는다. 안 그러면 20대로 나온다.
- 아이돌 느낌: "strikingly beautiful … with a k-pop idol look, small round oval face, short chin, large clear eyes, defined double eyelids".
- 체형을 보이려면(뚱뚱함 등) 앞에 "medium shot showing his head, shoulders and upper body"를 붙인다.
- 정면 구도라 **포니테일·땋은 머리가 잘 안 보인다**. 고개를 돌리라고 적어도 잘 안 된다. 손보기로 덧그리는 편이 확실하다.
- "cat-like eyes"는 고양이 귀 후드가 된다. 동물·소품 낱말은 그림에 그대로 나온다.
- 후드·모자 낱말이 있으면 머리를 덮는다. 머리 모양을 보여 줄 얼굴엔 "bare head"를 넣는다.

## 함정

- **`pnpm portraits`를 두 개 동시에 돌리지 않는다.** 둘 다 시작할 때 `portraits.lock.json`과 `boxes.json`을 읽고 끝날 때 덮어써서 한쪽 기록이 사라진다. 이어서 돌리려면 앞 작업이 끝나길 기다린다.
- `.cache/portraits/`(원본·후보·얼굴 상자)는 git에 없다. 워크트리를 지우면 함께 사라진다. 완성본·yaml·잠금 파일만 있으면 다시 그릴 수 있다.
- 지난 출력은 `~/dev/ComfyUI/output/trpg/`에 남는다 (`<id>_small_*`, `<id>_zoom_*`). 덮어쓴 완성본을 되살릴 때 여기서 찾는다.
- `--only`에 쉼표로 끝나는 목록을 주면 "없는 id"로 바로 끝난다.
