import argparse
import json
import os
import time
import urllib.error
import urllib.request


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("model")
    parser.add_argument("--question", default="Which active MLB teams have never been to the World Series?")
    parser.add_argument("--num-ctx", type=int, default=8192)
    parser.add_argument("--num-predict", type=int, default=1024)
    parser.add_argument("--temperature", type=float, default=0)
    parser.add_argument("--repeat-last-n", type=int, default=64)
    parser.add_argument("--think", action="store_true")
    parser.add_argument("--keep-alive", default="0")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    payload = {
        "model": args.model,
        "messages": [{"role": "user", "content": args.question}],
        "stream": False,
        "think": args.think,
        "keep_alive": args.keep_alive,
        "options": {
            "num_ctx": args.num_ctx,
            "temperature": args.temperature,
            "num_predict": args.num_predict,
            "repeat_last_n": args.repeat_last_n,
        },
    }
    request = urllib.request.Request(
        "http://localhost:8080/api/chat",
        data=json.dumps(payload).encode(),
        headers={
            "Authorization": f"Bearer {os.environ['GATEWAY_API_KEY']}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=1800) as response:
            status = response.status
            result = json.load(response)
    except urllib.error.HTTPError as error:
        status = error.code
        result = json.loads(error.read())

    message = result.get("message") or {}
    print(json.dumps({
        "model": args.model,
        "parameters": payload["options"] | {"think": args.think},
        "status": status,
        "wall_seconds": round(time.monotonic() - started, 3),
        "answer": message.get("content", ""),
        "done_reason": result.get("done_reason"),
        "prompt_eval_count": result.get("prompt_eval_count"),
        "eval_count": result.get("eval_count"),
    }, indent=2))


if __name__ == "__main__":
    main()