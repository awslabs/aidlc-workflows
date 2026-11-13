# Business Rules — Statistics

## BR-ST1: Minimum Elements
Empty arrays rejected via Pydantic (min_length=1). stdev/variance require >= 2 elements (validated in route before calling engine).

## BR-ST2: Mode Tie-Breaking
When multiple modes exist, return the smallest value.

## BR-ST3: Integer vs Float Results
count returns an integer; all other operations return float.
