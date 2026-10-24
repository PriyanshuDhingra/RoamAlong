"""The protocol schema, its generated pydantic models, and the example messages must agree."""

import json
import sys
from pathlib import Path

import jsonschema
import pytest
from pydantic import ValidationError

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "protocol" / "gen" / "py"))

from messages import DownlinkMessage, UplinkMessage

SCHEMA = json.loads((ROOT / "protocol" / "messages.schema.json").read_text())
EXAMPLES = json.loads((ROOT / "protocol" / "examples" / "messages.json").read_text())


def _validator(definition: str) -> jsonschema.Draft7Validator:
    return jsonschema.Draft7Validator({**SCHEMA, "$ref": f"#/definitions/{definition}"})


def test_schema_is_valid_draft7():
    jsonschema.Draft7Validator.check_schema(SCHEMA)


@pytest.mark.parametrize("msg", EXAMPLES["uplink"], ids=lambda m: m["type"])
def test_uplink_examples(msg):
    _validator("UplinkMessage").validate(msg)
    assert UplinkMessage.model_validate(msg).root.type == msg["type"]


@pytest.mark.parametrize("msg", EXAMPLES["downlink"], ids=lambda m: m["type"])
def test_downlink_examples(msg):
    _validator("DownlinkMessage").validate(msg)
    assert DownlinkMessage.model_validate(msg).root.type == msg["type"]


@pytest.mark.parametrize("msg", EXAMPLES["invalid_uplink"], ids=lambda m: m["type"])
def test_invalid_uplink_rejected(msg):
    assert not _validator("UplinkMessage").is_valid(msg)
    with pytest.raises(ValidationError):
        UplinkMessage.model_validate(msg)
