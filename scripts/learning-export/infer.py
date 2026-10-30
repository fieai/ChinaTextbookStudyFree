"""Run the frozen WP-10 inference implementation without writing to its repository."""

import json
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, sys.argv[1])
from inference_v1 import infer_question  # noqa: E402

questions = json.load(sys.stdin)
json.dump([infer_question(question) if question['type'] != 'true_false' else None
           for question in questions], sys.stdout, ensure_ascii=False)
