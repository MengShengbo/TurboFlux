# Three-CLI 12-Case Retrieval Comparison

TurboFlux was rerun after the retrieval fixes. Claude Code and OpenCode were not rerun; their rows reuse the complete historical matrix on the same cases, commits, model, reasoning setting, and scoring contract.

## Aggregate

| System | Success | R@10 | MRR | Full@10 | p50 | Mean tokens in/out |
|---|---:|---:|---:|---:|---:|---:|
| TurboFlux | 100.0% | 0.722 | 0.771 | 66.7% | 135.0s | 19408 / 1805 |
| Claude Code | 100.0% | 0.833 | 0.833 | 75.0% | 64.2s | 33936 / 1565 |
| OpenCode | 58.3% | 0.556 | 0.583 | 50.0% | 166.2s | 65218 / 2007 |

## Per Case

| Case | Gold files | TurboFlux R@10 / MRR / s | Claude Code R@10 / MRR / s | OpenCode R@10 / MRR / s | ContextMaps |
|---|---:|---:|---:|---:|---:|
| pydata__xarray-6461 | 1 | 1.000 / 1.000 / 135.0 | 1.000 / 1.000 / 53.0 | 1.000 / 1.000 / 166.2 | on |
| trinodb__trino-3392 | 1 | 0.000 / 0.000 / 138.1 | 1.000 / 1.000 / 49.7 | 0.000 / 0.000 / 300.6 | on |
| django__django-12193 | 1 | 1.000 / 1.000 / 155.6 | 1.000 / 0.500 / 33.4 | 0.000 / 0.000 / 308.4 | on |
| serverless__serverless-3534 | 6 | 0.333 / 1.000 / 160.0 | 0.667 / 1.000 / 67.3 | 0.667 / 1.000 / 148.7 | on |
| matplotlib__matplotlib-24970 | 1 | 1.000 / 1.000 / 153.5 | 1.000 / 1.000 / 96.5 | 1.000 / 1.000 / 278.0 | on |
| langchain-ai__langchain-20064 | 1 | 0.000 / 0.000 / 133.1 | 1.000 / 1.000 / 59.7 | 1.000 / 1.000 / 183.0 | on |
| pylint-dev__pylint-7080 | 1 | 1.000 / 1.000 / 139.1 | 1.000 / 0.500 / 69.4 | 0.000 / 0.000 / 305.4 | on |
| microsoft__vscode-135805 | 1 | 1.000 / 0.250 / 122.0 | 0.000 / 0.000 / 121.9 | 0.000 / 0.000 / 333.4 | on |
| astropy__astropy-7671 | 1 | 1.000 / 1.000 / 53.5 | 1.000 / 1.000 / 36.3 | 1.000 / 1.000 / 180.6 | on |
| google__gson-2549 | 3 | 0.333 / 1.000 / 40.7 | 1.000 / 1.000 / 64.2 | 1.000 / 1.000 / 67.8 | on |
| pytest-dev__pytest-10051 | 1 | 1.000 / 1.000 / 39.6 | 1.000 / 1.000 / 131.4 | 1.000 / 1.000 / 95.6 | on |
| prettier__prettier-661 | 3 | 1.000 / 1.000 / 69.6 | 0.333 / 1.000 / 40.1 | 0.000 / 0.000 / 335.4 | on |

## Ranked Paths

### pydata__xarray-6461

Gold: `xarray/core/computation.py`

- TurboFlux: `xarray/core/computation.py`, `xarray/__init__.py`, `xarray/core/dataarray.py`, `xarray/tests/test_computation.py`, `xarray/core/arithmetic.py`, `xarray/core/common.py`
- Claude Code: `xarray/core/computation.py`, `xarray/core/duck_array_ops.py`
- OpenCode: `xarray/core/computation.py`, `xarray/core/merge.py`, `xarray/core/duck_array_ops.py`, `xarray/core/ops.py`, `xarray/core/common.py`, `xarray/core/options.py`

### trinodb__trino-3392

Gold: `presto-main/src/main/java/io/prestosql/operator/scalar/StringFunctions.java`

- TurboFlux: `presto-main/src/main/java/io/prestosql/type/likefunctions.java`, `presto-teradata-functions/src/main/java/io/prestosql/teradata/functions/teradatastringfunctions.java`, `presto-parser/src/main/java/io/prestosql/sql/parser/astbuilder.java`, `presto-jdbc/src/main/java/io/prestosql/jdbc/prestodatabasemetadata.java`, `presto-main/src/main/java/io/prestosql/type/re2jregexp.java`, `presto-parser/src/main/java/io/prestosql/sql/parser/errorhandler.java`, `presto-local-file/src/main/java/io/prestosql/plugin/localfile/localfileconfig.java`, `presto-password-authenticators/src/main/java/io/prestosql/plugin/password/ldap/ldapauthenticator.java`
- Claude Code: `presto-main/src/main/java/io/prestosql/operator/scalar/stringfunctions.java`, `presto-main/src/test/java/io/prestosql/operator/scalar/teststringfunctions.java`
- OpenCode: no valid ranking (timeout)

### django__django-12193

Gold: `django/forms/widgets.py`

- TurboFlux: `django/forms/widgets.py`, `django/contrib/gis/forms/widgets.py`, `django/forms/utils.py`, `django/forms/fields.py`, `django/forms/__init__.py`, `django/contrib/postgres/forms/array.py`, `django/contrib/admin/widgets.py`, `django/contrib/auth/forms.py`, `django/forms/boundfield.py`
- Claude Code: `django/contrib/postgres/forms/array.py`, `django/forms/widgets.py`
- OpenCode: no valid ranking (timeout)

### serverless__serverless-3534

Gold: `lib/plugins/aws/package/compile/events/apiGateway/lib/authorizers.js`, `lib/plugins/aws/package/compile/events/apiGateway/lib/method/authorization.js`, `lib/plugins/aws/package/compile/events/apiGateway/lib/method/integration.js`, `lib/plugins/aws/package/compile/events/apiGateway/lib/method/responses.js`, `lib/plugins/aws/package/compile/events/apiGateway/lib/permissions.js`, `lib/plugins/aws/package/compile/events/apiGateway/lib/validate.js`

- TurboFlux: `lib/plugins/aws/package/compile/events/apigateway/lib/method/integration.js`, `lib/plugins/create/templates/aws-java-gradle/src/main/java/com/serverless/apigatewayresponse.java`, `lib/plugins/aws/package/compile/events/apigateway/lib/method/index.js`, `lib/plugins/aws/package/compile/events/apigateway/index.js`, `lib/plugins/aws/package/compile/events/apigateway/lib/resources.js`, `docs/providers/aws/events/apigateway.md`, `lib/plugins/aws/package/compile/events/apigateway/lib/cors.js`, `lib/plugins/aws/package/compile/events/apigateway/lib/authorizers.js`, `lib/plugins/aws/package/compile/events/apigateway/lib/apikeys.js`, `lib/plugins/aws/lib/naming.js`
- Claude Code: `lib/plugins/aws/package/compile/events/apigateway/lib/validate.js`, `lib/plugins/aws/package/compile/events/apigateway/lib/method/integration.js`, `lib/plugins/aws/package/compile/events/apigateway/lib/method/index.js`, `lib/plugins/aws/package/compile/events/apigateway/lib/permissions.js`, `lib/plugins/aws/package/compile/events/apigateway/lib/method/responses.js`, `lib/plugins/aws/package/compile/events/apigateway/index.js`, `lib/plugins/aws/package/compile/events/apigateway/lib/resources.js`
- OpenCode: `lib/plugins/aws/package/compile/events/apigateway/lib/validate.js`, `lib/plugins/aws/package/compile/events/apigateway/lib/method/integration.js`, `lib/plugins/aws/package/compile/events/apigateway/lib/method/index.js`, `lib/plugins/aws/package/compile/events/apigateway/lib/permissions.js`, `lib/plugins/aws/package/compile/events/apigateway/index.js`, `lib/plugins/aws/package/compile/events/apigateway/lib/method/responses.js`, `lib/plugins/aws/package/compile/events/apigateway/lib/resources.js`, `lib/plugins/aws/package/compile/events/apigateway/lib/cors.js`

### matplotlib__matplotlib-24970

Gold: `lib/matplotlib/colors.py`

- TurboFlux: `lib/matplotlib/colors.py`, `lib/matplotlib/cm.py`, `lib/matplotlib/pyplot.py`, `plot_types/stats/pie.py`, `lib/matplotlib/collections.py`, `lib/matplotlib/_cm_listed.py`, `lib/matplotlib/_cm.py`
- Claude Code: `lib/matplotlib/colors.py`, `lib/matplotlib/cm.py`, `lib/matplotlib/pyplot.py`
- OpenCode: `lib/matplotlib/colors.py`, `lib/matplotlib/cm.py`, `lib/matplotlib/pyplot.py`

### langchain-ai__langchain-20064

Gold: `libs/langchain/langchain/output_parsers/boolean.py`

- TurboFlux: `libs/core/langchain_core/output_parsers/base.py`, `templates/rag-pinecone-rerank/rag_pinecone_rerank/chain.py`, `libs/langchain/langchain/retrievers/contextual_compression.py`, `libs/langchain/langchain/retrievers/__init__.py`, `libs/core/langchain_core/retrievers.py`, `libs/core/langchain_core/vectorstores.py`
- Claude Code: `libs/langchain/langchain/output_parsers/boolean.py`, `libs/langchain/langchain/retrievers/document_compressors/chain_filter.py`, `libs/langchain/langchain/retrievers/document_compressors/chain_filter_prompt.py`, `libs/langchain/langchain/chains/llm.py`
- OpenCode: `libs/langchain/langchain/output_parsers/boolean.py`, `libs/langchain/langchain/retrievers/document_compressors/chain_filter.py`, `libs/langchain/langchain/retrievers/document_compressors/chain_filter_prompt.py`, `libs/langchain/langchain/retrievers/contextual_compression.py`, `libs/core/langchain_core/output_parsers/base.py`, `libs/langchain/langchain/output_parsers/__init__.py`, `libs/langchain/langchain/retrievers/document_compressors/__init__.py`, `libs/langchain/langchain/retrievers/document_compressors/base.py`

### pylint-dev__pylint-7080

Gold: `pylint/lint/expand_modules.py`

- TurboFlux: `pylint/lint/expand_modules.py`, `pylint/lint/pylinter.py`, `pylint/lint/base_options.py`, `pylint/lint/parallel.py`, `pylint/reporters/base_reporter.py`, `pylint/reporters/text.py`, `tests/lint/unittest_expand_modules.py`, `tests/lint/unittest_lint.py`, `pylint/utils/utils.py`, `pylint/typing.py`
- Claude Code: `pylint/lint/pylinter.py`, `pylint/lint/expand_modules.py`, `pylint/config/option.py`, `src/gen/about.py`, `pylint/lint/base_options.py`, `pylint/config/arguments_manager.py`
- OpenCode: `pylint/lint/pylinter.py`, `pylint/lint/expand_modules.py`

### microsoft__vscode-135805

Gold: `src/vs/editor/contrib/multicursor/multicursor.ts`

- TurboFlux: `src/vs/workbench/contrib/codeeditor/browser/togglewordwrap.ts`, `src/vs/editor/common/viewmodel/monospacelinebreakscomputer.ts`, `src/vs/editor/common/viewmodel/splitlinescollection.ts`, `src/vs/editor/contrib/multicursor/multicursor.ts`, `src/vs/editor/common/config/editoroptions.ts`, `src/vs/monaco.d.ts`, `src/vs/editor/common/config/commoneditorconfig.ts`
- Claude Code: `src/vs/editor/common/controller/cursormovecommands.ts`, `src/vs/editor/common/controller/cursormoveoperations.ts`, `src/vs/editor/browser/controller/corecommands.ts`, `src/vs/editor/common/controller/cursorcommon.ts`, `src/vs/editor/common/config/editoroptions.ts`, `src/vs/editor/common/viewmodel/viewmodelimpl.ts`, `src/vs/editor/common/viewmodel/splitlinescollection.ts`, `src/vs/editor/common/controller/cursorcollection.ts`
- OpenCode: no valid ranking (timeout)

### astropy__astropy-7671

Gold: `astropy/utils/introspection.py`

- TurboFlux: `astropy/utils/introspection.py`, `astropy/modeling/tabular.py`, `astropy/utils/compat/numpycompat.py`, `astropy/__init__.py`, `astropy/utils/__init__.py`, `astropy/io/misc/yaml.py`, `astropy/io/misc/asdf/tags/transform/basic.py`
- Claude Code: `astropy/utils/introspection.py`, `astropy/utils/tests/test_introspection.py`
- OpenCode: `astropy/utils/introspection.py`, `astropy/utils/tests/test_introspection.py`, `astropy/utils/compat/numpycompat.py`, `astropy/__init__.py`

### google__gson-2549

Gold: `gson/src/main/java/com/google/gson/internal/bind/DefaultDateTypeAdapter.java`, `gson/src/main/java/com/google/gson/internal/sql/SqlDateTypeAdapter.java`, `gson/src/main/java/com/google/gson/internal/sql/SqlTimeTypeAdapter.java`

- TurboFlux: `gson/src/main/java/com/google/gson/internal/bind/defaultdatetypeadapter.java`, `gson/src/main/java/com/google/gson/gsonbuilder.java`, `gson/src/main/java/com/google/gson/gson.java`, `gson/src/main/java/com/google/gson/typeadapter.java`, `gson/src/main/java/com/google/gson/stream/jsonreader.java`, `gson/src/main/java/com/google/gson/stream/jsonwriter.java`
- Claude Code: `gson/src/main/java/com/google/gson/internal/bind/defaultdatetypeadapter.java`, `gson/src/main/java/com/google/gson/internal/sql/sqldatetypeadapter.java`, `gson/src/main/java/com/google/gson/internal/sql/sqltimetypeadapter.java`, `gson/src/main/java/com/google/gson/internal/sql/sqltimestamptypeadapter.java`, `gson/src/main/java/com/google/gson/gsonbuilder.java`
- OpenCode: `gson/src/main/java/com/google/gson/internal/bind/defaultdatetypeadapter.java`, `gson/src/main/java/com/google/gson/internal/sql/sqltypessupport.java`, `gson/src/main/java/com/google/gson/gsonbuilder.java`, `gson/src/main/java/com/google/gson/internal/sql/sqldatetypeadapter.java`, `gson/src/main/java/com/google/gson/internal/sql/sqltimetypeadapter.java`

### pytest-dev__pytest-10051

Gold: `src/_pytest/logging.py`

- TurboFlux: `src/_pytest/logging.py`, `testing/logging/test_fixture.py`, `src/_pytest/fixtures.py`, `src/_pytest/runner.py`
- Claude Code: `src/_pytest/logging.py`
- OpenCode: `src/_pytest/logging.py`, `testing/logging/test_fixture.py`

### prettier__prettier-661

Gold: `bin/prettier.js`, `src/options.js`, `src/printer.js`

- TurboFlux: `src/printer.js`, `src/doc-builders.js`, `src/doc-printer.js`, `src/parser.js`, `tests_config/run_spec.js`, `src/options.js`, `bin/prettier.js`, `src/doc-utils.js`, `src/comments.js`
- Claude Code: `src/printer.js`, `src/doc-builders.js`
- OpenCode: `src/printer.js`

## Provenance

- TurboFlux: `benchmark-results/2026-07-23-fastcontext-current-quality-12/runs.jsonl`
- Claude Code / OpenCode: `benchmark-results/2026-07-22-gpt-5.5-dual-specialist-quality-gate-12/runs.jsonl`
- Model: `gpt-5.5`; native reasoning disabled.
- Comparator values count failed runs as zero, matching the benchmark report.
