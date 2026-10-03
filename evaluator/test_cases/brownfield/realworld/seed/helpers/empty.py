from typing import Final

from pydantic import BaseModel


class _Empty(BaseModel):
    """
    An instance of this class may be used to represent undefined data (different than None)
    without breaking the `openapi.json` generation used by Swagger, as this ends-up calling `to_jsonable_python` on it
    """

    pass


EMPTY: Final = _Empty()
