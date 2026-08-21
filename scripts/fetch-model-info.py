#!/usr/bin/env python3
"""
Fetch model context window information from Hugging Face and LM Studio.
Does NOT use LLMs - only fetches configuration data.
"""

import json
import sys
import urllib.request
import urllib.error
from pathlib import Path


def fetch_huggingface_config(model_id: str) -> dict:
    """Fetch config.json from Hugging Face Hub."""
    # Try multiple URL formats
    urls = [
        f"https://huggingface.co/{model_id}/raw/main/config.json",
        f"https://huggingface.co/{model_id}/resolve/main/config.json",
        f"https://huggingface.co/{model_id}/blob/main/config.json",
    ]

    for url in urls:
        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
            })
            with urllib.request.urlopen(req, timeout=10) as response:
                return json.loads(response.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            if e.code == 401:
                # Try without auth - some models are gated
                continue
            if e.code == 404:
                continue
            return {"error": f"HTTP error {e.code}: {e}"}
        except Exception:
            continue

    return {"error": "Failed to fetch config from all URLs"}


def fetch_hf_hub_api(model_id: str) -> dict:
    """Fetch model info from Hugging Face Hub API."""
    url = f"https://huggingface.co/api/models/{model_id}"

    try:
        req = urllib.request.Request(url, headers={
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        })
        with urllib.request.urlopen(req, timeout=10) as response:
            return json.loads(response.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        return {"error": f"API error {e.code}: {e}"}
    except Exception as e:
        return {"error": f"Failed to fetch from API: {e}"}


def extract_context_window(config: dict) -> dict:
    """Extract context window information from model config."""
    result = {
        "max_position_embeddings": config.get("max_position_embeddings"),
        "sliding_window": config.get("sliding_window"),
        "model_type": config.get("model_type"),
        "architectures": config.get("architectures", []),
    }

    # Some models use different field names
    if result["max_position_embeddings"] is None:
        # Try alternative field names
        for key in ["n_positions", "n_ctx", "max_seq_len", "max_sequence_length"]:
            if key in config:
                result["max_position_embeddings"] = config[key]
                result["source_field"] = key
                break

    # Check for rope_scaling which indicates extended context support
    if "rope_scaling" in config:
        result["rope_scaling"] = config["rope_scaling"]

    return result


def find_lm_studio_models() -> list:
    """Find models installed in LM Studio."""
    models = []

    # Common LM Studio model directories
    lm_studio_paths = [
        Path.home() / ".cache" / "lm-studio" / "models",
        Path.home() / ".lmstudio" / "models",
        Path.home() / "Library" / "Application Support" / "LM Studio" / "models",
    ]

    for base_path in lm_studio_paths:
        if not base_path.exists():
            continue

        for publisher_dir in base_path.iterdir():
            if not publisher_dir.is_dir():
                continue

            for model_dir in publisher_dir.iterdir():
                if not model_dir.is_dir():
                    continue

                config_path = model_dir / "config.json"
                if config_path.exists():
                    try:
                        with open(config_path) as f:
                            config = json.load(f)

                        models.append({
                            "id": f"{publisher_dir.name}/{model_dir.name}",
                            "path": str(model_dir),
                            "config": extract_context_window(config),
                        })
                    except Exception as e:
                        models.append({
                            "id": f"{publisher_dir.name}/{model_dir.name}",
                            "path": str(model_dir),
                            "error": str(e),
                        })

    return models


def main():
    if len(sys.argv) < 2:
        print("Usage: fetch-model-info.py <command> [args]")
        print("")
        print("Commands:")
        print("  huggingface <model_id>  - Fetch config from Hugging Face")
        print("                          Example: huggingface mlx-community/Qwen3-30B-A3B-Instruct-MLX")
        print("  hub <model_id>          - Fetch info from Hugging Face Hub API")
        print("  lmstudio                - List all LM Studio installed models")
        print("  context <model_id>      - Get just the context window info")
        print("  auto <model_id>         - Try all sources to find context window")
        sys.exit(1)

    command = sys.argv[1]

    if command == "huggingface":
        if len(sys.argv) < 3:
            print("Error: model_id required")
            sys.exit(1)

        model_id = sys.argv[2]
        print(f"Fetching config for {model_id} from Hugging Face...")

        config = fetch_huggingface_config(model_id)

        if "error" in config:
            print(f"Error: {config['error']}")
            sys.exit(1)

        context_info = extract_context_window(config)

        print("\n=== Model Configuration ===")
        print(json.dumps(context_info, indent=2))

        print("\n=== Raw Config (relevant fields) ===")
        relevant_keys = [k for k in config.keys() if "max" in k.lower() or "position" in k.lower() or "window" in k.lower() or "rope" in k.lower() or "ctx" in k.lower()]
        for key in relevant_keys:
            print(f"  {key}: {config[key]}")

    elif command == "lmstudio":
        print("Scanning LM Studio models...")
        models = find_lm_studio_models()

        if not models:
            print("No LM Studio models found.")
            sys.exit(0)

        print(f"\nFound {len(models)} models:\n")

        for model in models:
            print(f"Model: {model['id']}")
            print(f"  Path: {model['path']}")

            if "error" in model:
                print(f"  Error: {model['error']}")
            else:
                ctx = model['config']
                max_pos = ctx.get('max_position_embeddings', 'N/A')
                print(f"  Context Window: {max_pos:,} tokens" if isinstance(max_pos, int) else f"  Context Window: {max_pos}")

                if ctx.get('sliding_window'):
                    print(f"  Sliding Window: {ctx['sliding_window']:,} tokens")

            print()

    elif command == "context":
        if len(sys.argv) < 3:
            print("Error: model_id required")
            sys.exit(1)

        model_id = sys.argv[2]
        config = fetch_huggingface_config(model_id)

        if "error" in config:
            print(json.dumps({"error": config["error"]}))
            sys.exit(1)

        context_info = extract_context_window(config)
        print(json.dumps(context_info, indent=2))

    elif command == "hub":
        if len(sys.argv) < 3:
            print("Error: model_id required")
            sys.exit(1)

        model_id = sys.argv[2]
        print(f"Fetching info for {model_id} from Hugging Face Hub API...")

        info = fetch_hf_hub_api(model_id)

        if "error" in info:
            print(f"Error: {info['error']}")
            sys.exit(1)

        # Extract relevant info
        result = {
            "id": info.get("id"),
            "tags": info.get("tags", []),
            "pipeline_tag": info.get("pipeline_tag"),
            "downloads": info.get("downloads"),
            "likes": info.get("likes"),
        }

        # Look for context window in tags or card data
        if "tags" in info:
            for tag in info["tags"]:
                if "context" in tag.lower() or "token" in tag.lower():
                    print(f"Found tag: {tag}")

        print(json.dumps(result, indent=2))

    elif command == "auto":
        if len(sys.argv) < 3:
            print("Error: model_id required")
            sys.exit(1)

        model_id = sys.argv[2]
        print(f"Auto-fetching context window for: {model_id}")
        print("=" * 60)

        # Try Hugging Face config first
        print("\n1. Trying Hugging Face config.json...")
        config = fetch_huggingface_config(model_id)

        if "error" not in config:
            context_info = extract_context_window(config)
            print(f"   ✓ Found config")
            print(f"   Context Window: {context_info.get('max_position_embeddings', 'N/A')}")
            if context_info.get('sliding_window'):
                print(f"   Sliding Window: {context_info['sliding_window']}")
        else:
            print(f"   ✗ {config['error']}")

        # Try Hub API
        print("\n2. Trying Hugging Face Hub API...")
        hub_info = fetch_hf_hub_api(model_id)

        if "error" not in hub_info:
            print(f"   ✓ Found model on Hub")
            print(f"   Model ID: {hub_info.get('id')}")
            print(f"   Downloads: {hub_info.get('downloads', 'N/A')}")
            print(f"   Likes: {hub_info.get('likes', 'N/A')}")

            # Check tags for context info
            tags = hub_info.get('tags', [])
            context_tags = [t for t in tags if 'context' in t.lower() or 'token' in t.lower() or 'window' in t.lower()]
            if context_tags:
                print(f"   Context-related tags: {context_tags}")
        else:
            print(f"   ✗ {hub_info['error']}")

        # Check LM Studio
        print("\n3. Checking LM Studio local models...")
        lm_models = find_lm_studio_models()

        matching = [m for m in lm_models if model_id.lower() in m['id'].lower() or any(model_id.lower() in str(p).lower() for p in [m.get('path', '')])]

        if matching:
            for model in matching:
                print(f"   ✓ Found in LM Studio: {model['id']}")
                if 'config' in model:
                    max_pos = model['config'].get('max_position_embeddings', 'N/A')
                    print(f"   Local Context Window: {max_pos}")
        else:
            print(f"   ✗ Not found in LM Studio")

        print("\n" + "=" * 60)

    else:
        print(f"Unknown command: {command}")
        sys.exit(1)


if __name__ == "__main__":
    main()
