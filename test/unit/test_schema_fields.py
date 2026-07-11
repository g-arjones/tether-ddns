"""Tests for the labeled_field schema helper."""
from typing import Annotated, Literal

from pydantic import BaseModel

from tether_ddns.schema_fields import labeled_field


def test_labeled_field_sets_title_description_and_enum_labels() -> None:
    """labeled_field surfaces title, description and x-enum-labels in the schema."""
    class Model(BaseModel):
        proto: Annotated[
            Literal['tcp', 'tcp_udp'],
            labeled_field(
                title='Protocol', description='Wire protocol',
                labels={'tcp': 'TCP', 'tcp_udp': 'TCP + UDP'}),
        ] = 'tcp'

    schema = Model.model_json_schema()
    prop = schema['properties']['proto']
    assert prop['title'] == 'Protocol'
    assert prop['description'] == 'Wire protocol'
    assert prop['x-enum-labels'] == {'tcp': 'TCP', 'tcp_udp': 'TCP + UDP'}


def test_labeled_field_without_labels_has_no_enum_labels_key() -> None:
    """Omitting labels leaves the schema free of an x-enum-labels key."""
    class Model(BaseModel):
        name: Annotated[str, labeled_field(title='Name')] = ''

    prop = Model.model_json_schema()['properties']['name']
    assert prop['title'] == 'Name'
    assert 'x-enum-labels' not in prop


def test_labeled_field_merges_existing_json_schema_extra() -> None:
    """A caller-provided json_schema_extra is preserved alongside x-enum-labels."""
    class Model(BaseModel):
        v: Annotated[
            str,
            labeled_field(
                labels={'a': 'A'}, json_schema_extra={'x-foo': 'bar'}),
        ] = 'a'

    prop = Model.model_json_schema()['properties']['v']
    assert prop['x-enum-labels'] == {'a': 'A'}
    assert prop['x-foo'] == 'bar'
