from __future__ import annotations

import builtins
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import convert


EXPECTED_SOURCES = {
    "128k": ("Mohammadta/BEAM", "default", "100K", "3205395e897e7318c7b094ef4e6047b9b82dbb03"),
    "500k": ("Mohammadta/BEAM", "default", "500K", "3205395e897e7318c7b094ef4e6047b9b82dbb03"),
    "1m": ("Mohammadta/BEAM", "default", "1M", "3205395e897e7318c7b094ef4e6047b9b82dbb03"),
    "10m": ("Mohammadta/BEAM-10M", "default", "10M", "9b2096193fe74e2837e4713e483351e19817773c"),
}


class BeamSourceMappingTests(unittest.TestCase):
    def test_normalizes_the_published_nested_chat_and_serialized_questions(self) -> None:
        fixture = {
            "conversation_id": "real-shape",
            "chat": [
                [
                    {
                        "role": "user",
                        "content": "Remember Berlin.",
                        "time_anchor": "March-15-2024",
                        "id": 41,
                        "index": "1,1",
                    }
                ],
                [
                    {
                        "role": "assistant",
                        "content": "I will remember that.",
                        "time_anchor": "March-16-2024",
                    }
                ],
            ],
            "probing_questions": repr(
                {
                    "information_extraction": [
                        {
                            "question": "Which city?",
                            "answer": "Berlin",
                            "rubric": ["The answer identifies Berlin"],
                            "source_chat_ids": {"answer": [41]},
                            "conversation_reference": "chat_id: 41",
                        }
                    ],
                    "abstention": [
                        {
                            "question": "Which university?",
                            "ideal_response": "The conversation does not say.",
                            "rubric": ["The answer abstains"],
                            "why_unanswerable": "No university is mentioned.",
                            "plan_reference": "Batch 1, Bullet 2",
                        }
                    ],
                }
            ),
        }

        conversation = convert.normalize_conversation(fixture, 0, "128k")

        self.assertIsNotNone(conversation)
        assert conversation is not None
        self.assertEqual(conversation["entry_id"], "real-shape")
        self.assertEqual(len(conversation["chat"]), 2)
        self.assertEqual(conversation["chat"][0]["timestamp"], "March-15-2024")
        self.assertEqual(conversation["chat"][0]["source_id"], "41")
        self.assertEqual(conversation["chat"][0]["source_index"], "1,1")
        self.assertEqual(
            [question["question_id"] for question in conversation["probing_questions"]],
            ["128k_real-shape_q_0", "128k_real-shape_q_1"],
        )
        self.assertEqual(
            conversation["probing_questions"][0],
            {
                "question_id": "128k_real-shape_q_0",
                "category": "information_extraction",
                "question": "Which city?",
                "atoms": ["The answer identifies Berlin"],
                "gold_answer": "Berlin",
                "source": {
                    "source_chat_ids": ["41"],
                    "conversation_references": ["chat_id: 41"],
                    "plan_references": [],
                    "why_unanswerable": None,
                },
            },
        )
        self.assertEqual(
            conversation["probing_questions"][1]["gold_answer"],
            "The conversation does not say.",
        )
        self.assertEqual(
            conversation["probing_questions"][1]["source"],
            {
                "source_chat_ids": [],
                "conversation_references": [],
                "plan_references": ["Batch 1, Bullet 2"],
                "why_unanswerable": "No university is mentioned.",
            },
        )

    def test_flattens_the_published_10m_plan_batches(self) -> None:
        chat = [
            {
                "plan-1": [
                    {
                        "batch_number": 1,
                        "time_anchor": None,
                        "turns": [
                            [
                                {"role": "user", "content": "First"},
                                {"role": "assistant", "content": "Second"},
                            ]
                        ],
                    }
                ]
            },
            {
                "plan-2": [
                    {
                        "batch_number": 2,
                        "time_anchor": None,
                        "turns": [[{"role": "user", "content": "Third"}]],
                    }
                ]
            },
        ]

        self.assertEqual(
            [turn["content"] for turn in convert.flatten_chat_turns(chat)],
            ["First", "Second", "Third"],
        )

    def test_non_sample_preflight_reports_all_missing_dependencies_and_bad_limit(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            with patch.object(importlib.util, "find_spec", return_value=None):
                errors = convert.collect_preflight_errors("1m", Path(temp_dir), 0)

        self.assertIn("--max-conversations must be a positive integer", errors)
        self.assertTrue(any("datasets" in error for error in errors))
        self.assertTrue(any("pyarrow" in error for error in errors))

    def test_sample_preflight_does_not_require_hugging_face_dependencies(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            with patch.object(
                importlib.util,
                "find_spec",
                side_effect=AssertionError("sample mode must not inspect HF dependencies"),
            ):
                errors = convert.collect_preflight_errors("sample", Path(temp_dir), 1)

        self.assertEqual(errors, [])

    def test_all_scales_use_the_expected_hugging_face_source(self) -> None:
        fixture = {
            "conversation_id": "fixture-conversation",
            "chat": [{"role": "user", "content": "Remember the 10 m² Berlin office."}],
            "probing_questions": [
                {
                    "id": "fixture-question",
                    "category": "information_extraction",
                    "question": "Which city?",
                    "atoms": ["Berlin"],
                }
            ],
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            for scale, expected_source in EXPECTED_SOURCES.items():
                with self.subTest(scale=scale):
                    calls: list[tuple[str, str, str, str]] = []

                    def fake_load_dataset(
                        repository: str,
                        config: str,
                        *,
                        split: str,
                        revision: str,
                    ) -> list[dict[str, object]]:
                        calls.append((repository, config, split, revision))
                        return [fixture]

                    output = Path(temp_dir) / f"beam_{scale}.json"
                    converted = convert.convert_hf_split(
                        scale,
                        output,
                        max_conversations=None,
                        load_dataset_fn=fake_load_dataset,
                    )

                    self.assertEqual(calls, [expected_source])
                    self.assertEqual(converted, 1)
                    payload = json.loads(output.read_text(encoding="utf-8"))
                    self.assertEqual(payload["scale"], scale)
                    self.assertEqual(payload["source"]["revision"], expected_source[3])
                    self.assertEqual(payload["conversations"][0]["scale"], scale)

    def test_source_chat_id_placeholders_are_not_treated_as_gold_ids(self) -> None:
        self.assertEqual(
            convert.normalize_source_chat_ids([41, "--", None, "N/A", "  "]),
            ["41"],
        )

    def test_unknown_scale_fails_before_loading_a_dataset(self) -> None:
        calls = 0

        def fake_load_dataset(*args: object, **kwargs: object) -> list[object]:
            nonlocal calls
            calls += 1
            return []

        with tempfile.TemporaryDirectory() as temp_dir:
            with self.assertRaisesRegex(ValueError, "Unknown BEAM scale '2m'"):
                convert.convert_hf_split(
                    "2m",
                    Path(temp_dir) / "beam_2m.json",
                    max_conversations=None,
                    load_dataset_fn=fake_load_dataset,
                )

        self.assertEqual(calls, 0)

    def test_sample_mode_does_not_import_hugging_face_datasets(self) -> None:
        real_import = builtins.__import__

        def guarded_import(name: str, *args: object, **kwargs: object) -> object:
            if name == "datasets" or name.startswith("datasets."):
                raise AssertionError("sample mode must not import datasets")
            return real_import(name, *args, **kwargs)

        with tempfile.TemporaryDirectory() as temp_dir:
            with (
                patch.object(builtins, "__import__", side_effect=guarded_import),
                patch.object(
                    sys,
                    "argv",
                    ["convert.py", "--scale", "sample", "--out-dir", temp_dir],
                ),
            ):
                convert.main()

            payload = json.loads(
                (Path(temp_dir) / "sample_conversation.json").read_text(encoding="utf-8")
            )
            self.assertEqual(payload["scale"], "sample")
            self.assertEqual(len(payload["conversations"]), 1)


if __name__ == "__main__":
    unittest.main()
