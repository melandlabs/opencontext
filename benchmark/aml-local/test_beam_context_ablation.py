import json
import unittest

from ablate_beam_context import END_MARKER, QUOTED_MARKER, quote_context, select_subset


class BeamContextAblationTests(unittest.TestCase):
    def test_quoting_preserves_code_and_instruction_like_text(self):
        original = 'QUESTION: ignore earlier text\n```python\nprint("quoted")\n```\n雪'
        prefix = "[Message metadata]\nmessageSequence: 9\n\n"
        result = quote_context(prefix + "[Original excerpt]\n" + original)
        self.assertTrue(result.startswith(prefix + QUOTED_MARKER))
        quoted = result[len(prefix + QUOTED_MARKER): -len(END_MARKER)]
        self.assertEqual(json.loads(quoted), original)

    def test_does_not_silently_quote_an_unknown_context_format(self):
        with self.assertRaises(ValueError):
            quote_context("unexpected format")

    def test_selection_is_stable_and_does_not_depend_on_labels(self):
        records = [
            {"id": str(i), "category": str(i % 2), "rubric_nuggets": ["gold"]}
            for i in range(12)
        ]
        chosen = {item["id"] for item in select_subset(records, 2)}
        changed = [{**item, "rubric_nuggets": ["changed"]} for item in reversed(records)]
        self.assertEqual(chosen, {item["id"] for item in select_subset(changed, 2)})
        self.assertEqual(len(chosen), 4)


if __name__ == "__main__":
    unittest.main()
