# failing-mypy fixture sample — exactly one mypy type error.
#
# Assigning a str literal to an int-annotated binding triggers mypy's
# [assignment] error ("Incompatible types in assignment"). mypy emits a
# single error-severity diagnostic, so the type-check sensor's error count
# == 1 and the dispatcher records FAILED with Findings count=1.
x: int = "string"
value = x
