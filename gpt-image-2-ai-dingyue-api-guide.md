# gpt-image-2 via ai-dingyue API Guide

Last verified in this Codex workspace: 2026-08-06.

This note is for future AI agents that need to call `gpt-image-2` through the API relay at:

```text
https://www.ai-dingyue.com
```

Do not write the real API key into this document, source code, prompts, logs, or chat messages. Read it from the local environment.

## Quick Facts

- Model: `gpt-image-2`
- API base URL for this user: `https://www.ai-dingyue.com`
- Auth variable: `OPENAI_API_KEY`
- Base URL variable: `OPENAI_BASE_URL`
- The OpenAI Python SDK can use this relay by setting `OPENAI_BASE_URL=https://www.ai-dingyue.com`.
- In this workspace, `OPENAI_BASE_URL=https://www.ai-dingyue.com` was verified with the OpenAI Python SDK client.
- For editing an existing local image, get explicit user permission before uploading that image to the remote API.

## Environment Setup

PowerShell:

```powershell
setx OPENAI_API_KEY "your-ai-dingyue-api-key"
setx OPENAI_BASE_URL "https://www.ai-dingyue.com"
```

After `setx`, restart Codex or the terminal session so the variables are visible to child processes.

For one command only, without saving permanently:

```powershell
$env:OPENAI_API_KEY="your-ai-dingyue-api-key"
$env:OPENAI_BASE_URL="https://www.ai-dingyue.com"
```

Verify the SDK will use the relay:

```powershell
python -c "from openai import OpenAI; c=OpenAI(); print(str(c.base_url))"
```

Expected output:

```text
https://www.ai-dingyue.com
```

## Install Dependency

Use the active Python environment:

```powershell
python -m pip install openai
```

In Codex desktop, the bundled Python path may be available through `load_workspace_dependencies`. In this workspace it was:

```text
C:\Users\admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe
```

## Generate Image With Python SDK

```python
import base64
import os
from pathlib import Path

from openai import OpenAI

client = OpenAI(
    api_key=os.environ["OPENAI_API_KEY"],
    base_url=os.environ.get("OPENAI_BASE_URL", "https://www.ai-dingyue.com"),
)

result = client.images.generate(
    model="gpt-image-2",
    prompt="A photorealistic futuristic city at sunrise, no text, no watermark",
    size="1024x1024",
    quality="high",
)

image_bytes = base64.b64decode(result.data[0].b64_json)
Path("output.png").write_bytes(image_bytes)
```

## Edit Existing Image With Python SDK

Use this when the user provides a local image and explicitly approves uploading it to the API.

```python
import base64
import os
from pathlib import Path

from openai import OpenAI

client = OpenAI(
    api_key=os.environ["OPENAI_API_KEY"],
    base_url=os.environ.get("OPENAI_BASE_URL", "https://www.ai-dingyue.com"),
)

input_image = Path(r"C:\path\to\input.jpg")
output_image = Path("edited-output.png")

with input_image.open("rb") as image_file:
    result = client.images.edit(
        model="gpt-image-2",
        image=image_file,
        prompt=(
            "Edit the provided image while preserving its camera angle, lighting, "
            "and main composition. Apply the requested visual change. "
            "Do not add text, logos, or watermarks."
        ),
        size="1024x1536",
        quality="high",
    )

output_image.write_bytes(base64.b64decode(result.data[0].b64_json))
```

## Codex Imagegen CLI Pattern

The Codex imagegen fallback CLI uses `gpt-image-2` by default, but pass `--model gpt-image-2` explicitly when the user asks for that model.

PowerShell example:

```powershell
$env:OPENAI_BASE_URL='https://www.ai-dingyue.com'

& 'C:\Users\admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' `
  'C:\Users\admin\.codex\skills\.system\imagegen\scripts\image_gen.py' edit `
  --model gpt-image-2 `
  --image 'C:\path\to\input.jpg' `
  --prompt 'Edit the provided image according to the user request. Preserve original composition. No text, logos, or watermarks.' `
  --quality high `
  --size 1024x1536 `
  --out 'C:\path\to\output.png' `
  --force
```

Use `--dry-run` first to inspect the payload without making a network call:

```powershell
$env:OPENAI_BASE_URL='https://www.ai-dingyue.com'

python 'C:\Users\admin\.codex\skills\.system\imagegen\scripts\image_gen.py' edit `
  --model gpt-image-2 `
  --image 'C:\path\to\input.jpg' `
  --prompt 'Test edit' `
  --out 'C:\path\to\output.png' `
  --dry-run
```

## gpt-image-2 Options To Remember

- `quality`: `low`, `medium`, `high`, or `auto`.
- `size`: `auto` or a valid size such as `1024x1024`, `1536x1024`, `1024x1536`, `2048x1152`, `3840x2160`, or `2160x3840`.
- Do not set `input_fidelity` for `gpt-image-2`; image inputs are already high fidelity for this model.
- Do not use `background=transparent` with `gpt-image-2`; this model path does not support true transparent output. Use a separate confirmed fallback if native transparency is required.
- For image edits, input images must be under the API/provider file size limit.

## Privacy And Permission Rule

Before using an existing local image with `images.edit`, future agents must confirm that the user allows uploading that exact file to the remote API endpoint. A suitable confirmation is:

```text
I agree to upload <local image path> to the Image API endpoint at https://www.ai-dingyue.com and use gpt-image-2 to generate/edit the image.
```

Do not bypass this with indirect scripts, alternate tools, or hidden uploads.

## Troubleshooting

`401 invalid_api_key`

- The environment variable exists, but the key is invalid, expired, revoked, mistyped, or not accepted by the relay.
- Ask the user to set a valid relay key locally. Do not ask them to paste the key in chat.

Wrong endpoint or default OpenAI endpoint used

- Confirm `OPENAI_BASE_URL` is set in the same process that runs Python.
- Print `OpenAI().base_url` before the call.

Package missing

```powershell
python -m pip install openai
```

Network/sandbox blocked

- In Codex, retry the exact API command with scoped escalation and a clear justification.

Unsupported parameter

- Remove parameters not supported by `gpt-image-2`, especially `input_fidelity` and `background=transparent`.

## Known Working Pattern From This Workspace

The following pattern succeeded in this workspace:

```powershell
$env:OPENAI_BASE_URL='https://www.ai-dingyue.com'

& '<bundled-python>\python.exe' '<codex-home>\skills\.system\imagegen\scripts\image_gen.py' edit `
  --model gpt-image-2 `
  --image '<local-image-path>' `
  --prompt '<edit prompt>' `
  --quality high `
  --size 1024x1536 `
  --out '<workspace-output-path>.png' `
  --force
```

Replace placeholders with real local paths. Keep the API key in `OPENAI_API_KEY`.
