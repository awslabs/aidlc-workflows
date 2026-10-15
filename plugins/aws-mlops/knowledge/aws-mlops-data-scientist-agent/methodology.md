# Scientific quality

Read `aidlc-shared/aws-mlops.md` for the shared method and AWS architecture.

## Experiment protocol

Declare business value separately from model metrics. Define the prediction
target, unit of observation, decision time and label availability. A random
split is inappropriate when time, subject overlap or post-outcome features
leak information. Version the split and document exclusions, sample sizes,
missingness and selection bias.

Choose acceptance thresholds before consulting final test results. Use
validation data for tuning; repeated use of a test set requires a new holdout
or a clearly stated limitation. Report baseline comparisons, confidence or
uncertainty estimates and relevant population slices. Distinguish a model
accepted for experimentation from one accepted for production.

## Continuous quality

Specify label source, delay, coverage, join keys and evaluation windows.
Without ground truth, report data/prediction drift and service health; retain
predictive quality as unmeasured. Bias and explanation methods depend on the
problem and authorized attributes. SHAP or group metrics need appropriate
assumptions and tests; installing a library does not establish fairness.
