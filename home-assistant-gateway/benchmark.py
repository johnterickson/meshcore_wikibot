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
    parser.add_argument("--num-predict", type=int, default=102400)
    parser.add_argument("--temperature", type=float, default=0.2)
    parser.add_argument("--repeat-last-n", type=int, default=64)
    thinking = parser.add_mutually_exclusive_group()
    thinking.add_argument("--think", dest="think", action="store_true")
    thinking.add_argument("--no-think", dest="think", action="store_false")
    thinking.add_argument(
        "--think-level",
        dest="think",
        choices=("low", "medium", "high", "max"),
    )
    parser.set_defaults(think="low")
    parser.add_argument("--keep-alive", default="-1")
    parser.add_argument("--timeout-seconds", type=int, default=72000)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    keep_alive = int(args.keep_alive) if args.keep_alive.lstrip("-").isdigit() else args.keep_alive
    payload = {
        "model": args.model,
        "messages": [{"role": "user", "content": args.question}],
        "stream": False,
        "keep_alive": keep_alive,
        "options": {
            "num_ctx": args.num_ctx,
            "temperature": args.temperature,
            "num_predict": args.num_predict,
            "repeat_last_n": args.repeat_last_n,
        },
    }
    payload["think"] = args.think
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
        with urllib.request.urlopen(request, timeout=args.timeout_seconds) as response:
            status = response.status
            result = json.load(response)
    except urllib.error.HTTPError as error:
        status = error.code
        error_body = error.read()
        try:
            result = json.loads(error_body)
        except (json.JSONDecodeError, UnicodeDecodeError):
            result = {"error": error_body.decode("utf-8", errors="replace")}

    message = result.get("message") or {}
    print(json.dumps({
        "model": args.model,
        "parameters": payload["options"] | {
            "think": args.think,
            "keep_alive": keep_alive,
            "timeout_seconds": args.timeout_seconds,
        },
        "status": status,
        "wall_seconds": round(time.monotonic() - started, 3),
        "answer": message.get("content", ""),
        "thinking": message.get("thinking", ""),
        "error": result.get("detail") or result.get("error"),
        "done_reason": result.get("done_reason"),
        "prompt_eval_count": result.get("prompt_eval_count"),
        "eval_count": result.get("eval_count"),
    }, indent=2))
    if status >= 400:
        raise SystemExit(1)


if __name__ == "__main__":
    main()