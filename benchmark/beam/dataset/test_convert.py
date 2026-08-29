from __future__ import annotations

import builtins
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import convert


EXPECTED_SOURCES = {
    "128k": ("Mohammadta/BEAM", "default", "100K"),
    "500k": ("Mohammadta/BEAM", "default", "500K"),
    "1m": ("Mohammadta/BEAM", "default", "1M"),
    "10m": ("Mohammadta/BEAM-10M", "default", "10M"),
}


class BeamSourceMappingTests(unittest.TestCase):
    def test_all_scales_use_the_expected_hugging_face_source(self) -> None:
        fixture = {
            "conversation_id": "fixture-conversation",
            "chat": [{"role": "user", "content": "Remember Berlin."}],
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
                    calls: list[tuple[str, str, str]] = []

                    def fake_load_dataset(
                        repository: str,
                        config: str,
                        *,
                        split: str,
                    ) -> list[dict[str, object]]:
                        calls.append((repository, config, split))
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
                    payload = json.loads(output.read_text())
                    self.assertEqual(payload["scale"], scale)
                    self.assertEqual(payload["conversations"][0]["scale"], scale)

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
                (Path(temp_dir) / "sample_conversation.json").read_text()
            )
            self.assertEqual(payload["scale"], "sample")
            self.assertEqual(len(payload["conversations"]), 1)


if __name__ == "__main__":
    unittest.main()
