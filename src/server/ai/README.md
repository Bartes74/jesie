# Durable AI proposals

`store.ts` owns state and cost accounting. Provider and workflow code may call its worker functions, but these functions must not be exposed as unguarded HTTP mutations. User routes authenticate the live administrator, enforce same origin, and pass server-loaded actor identity.

A job captures the exact recipe content, revision, instruction, model, target, and stored author identity. The database prevents changing these fields, completed results, registered assets, and cost ledger entries. Assets expose only `/media/<id>` in DTOs; private WebP and optional original image blob pathnames remain server data.

## Submission and replay

Creation happens in one transaction under a shared advisory lock. A durable request key returns the same job, while an active identical input hash also deduplicates clicks using different keys. `createJobAdmission` atomically identifies the single creator; only that request dispatches a workflow. A queued job left by a process crash before dispatch can be cancelled and created anew; cancellation prevents a late worker from submitting it. Captured recipe revision uses optimistic concurrency. The current role and disabled flag are checked during creation and immediately before a new paid provider request.

`claimSubmission` writes `submitting` before the network call. A replay of a submission lacking its provider request ID becomes `uncertain` and cannot authorize another paid POST. `ensureSubmissionAllowed` is the worker preflight after slow image preparation. A worker that observes cancellation before actually posting may call `confirmNotSubmitted`; this proof path is unavailable from user APIs.

`attachProviderRequest` preserves the provider ID permanently. `resumeJob` can only resume reading a known provider request with no saved result, including retrying a completed image download. It creates neither another provider request nor another paid submission. In-flight cancellation retains cost and the remote concurrency slot until completion is proven; an eventual result stays cancelled and cannot be applied.

Provider bookkeeping continues if the creator is later disabled, so accepted charges and completion cannot disappear. Current authorization remains mandatory for every user action and any new paid submission.

## Actual costs

Financial caps and reservations were removed on 19 October 2026. New jobs, searches and photograph packages reserve zero. Legacy fields and immutable ledger rows remain for historical audit; they are never used to authorize or block work. Legacy limit mutation endpoints return 410 after fresh authorization.

`dailyUsedUsd`, `monthlyUsedUsd` and `pilotUsedUsd` contain only confirmed `usage` costs. Unknown charges remain null and are shown separately as pending; a missing provider bill never implies a free generation. Studio uses UTC reporting windows; radar uses Europe/Warsaw calendar months. At most two unfinished remote requests are admitted. Concurrency, authentication, input checks and recovery rules depend on job identity and state, independently of monetary values.

**Sprawdź rozliczenie pakietu** reads accepted receipts through the authenticated `/api/admin/ai/photo-batches/[id]/billing` endpoint. GET is diagnostic; POST `{ "action": "reconcile" }` appends verified accounting under the shared lock. Only complete `cost_total` records qualify, including an explicitly confirmed zero. Missing bills, estimates and permission failures leave charges pending. Use the server-only `FAL_BILLING_KEY` with the provider's `BILLING` preset when needed; raw errors and keys never reach the browser.

The ledger appends confirmed settlement and reconciliation deltas without rewriting historical records. No bill is inferred from an image result. Accepted requests keep their immutable receipt; unknown acceptance cannot authorize an automatic paid retry. Historical ceilings no longer constrain new children or recovery. Unique ingredient producers remain guarded by identity, regardless of zero reservation.

## Manual application and publication

A ready result is a proposal separate from the recipe. `applyJob` checks the current recipe revision atomically with the job. A result based on an older revision requires explicit acknowledgement. Content proposals preserve current original text, author, sources, and compatible photographs. Recipe identity, hero selection, provenance, and kitchen testing claims are controlled by the server. Generated content is always marked as an untested AI draft.

Image application changes only its captured hero, ingredient, or step target, and refuses a removed target. A changed hero subject, final appearance or container is rejected even with stale-result acknowledgement. Application writes ordinary editorial version and audit records, resets all review checks and approval, and never changes the active immutable publication. Publication accepts generated media only after an actual immutable asset row confirms the ID and image kind. Arbitrary `/media/` paths do not pass validation. Public asset access is granted only by a current active publication reference; withdrawing the recipe removes that public visibility.

New recipe jobs capture `aiPhotography.recipeTimingVersion: dependency-timing-v1` at admission, alongside the recipe/research schema versions. Studio, guided editing, daily research and legacy trend entry points share that admission path. These jobs require a structured `timingPlan`: `pollText` passes it to the captured proposal validator before `finishRecipe` can receive the accepted content. The validator checks task coverage, dependencies, one-cook and equipment constraints, and the active/cooking/rest unions and elapsed total. Planning assumptions and task details stay private; the plan is removed before building recipe fields and is never copied into public cooking prose.

The immutable job input selects the contract for submission, polling and repair. Existing and in-flight jobs without `recipeTimingVersion` retain their original schema; a repair copies its parent's complete captured metadata, including a researched job predating the timing contract, without upgrading it. Ordinary manual edits and historical snapshots do not acquire a new required plan. The timing contract does not change content ownership, photo source guards, human approval or the separate publication decision.

New recipe admission also captures `recipeDietVersion: ingredient-diet-v1`, plus a trusted `recipeDietTarget` when a daily selection supplied one. Generation and correction receive the same ingredient policy. The application derives the single category from the actual base ingredients; the model cannot satisfy a quota by returning a label. Ambiguous compounds and a mismatch with a captured target return repairable field issues. A correction inherits its parent's contract and target without upgrading old receipts. Optional substitutions and unreviewed historical dietary tags are not classification evidence. Dietary indexing does not assert allergen freedom or kitchen testing.

## Finished-dish photography

New recipe jobs capture `recipeProposalVersion: finished-dish-v2`; new hero jobs capture `heroStyleProfile: jesie-finished-dish-v2`. New recipe admissions also capture `recipePresentationVersion: required-finished-dish-v1`: the existing text response must include a non-null vessel and bilingual finished appearance. A missing or incomplete presentation uses the same bounded, repairable recipe-validation path. Repairs inherit the exact captured marker, while older and in-flight inputs without it retain their nullable schema. Historical inputs without these markers keep their original schema and photographic instructions. Recipe JSON optionally stores `heroPresentation` with a plate, bowl, clay pot, cooking pot, pan, baking dish, platter, sauce boat, jar, bottle or drinking glass, a bounded bilingual final appearance and existing evidence step IDs. These editorial settings are excluded from reader data.

The recipe model supplies the final-state suggestion within its existing text request. For older nullable captures, an explicit `null` remains unresolved in the saved record; a recipe-derived suggestion may be shown for review, but merely viewing it never writes a guessed plate. Internal step evidence remains server/model provenance, not an additional task for the editor. Legacy identity and approval checks retain their original local fallback exactly. New photo proposals use the improved recipe-derived vessel and final serving details in separate immutable photography metadata, so a richer suggestion does not invalidate an earlier review or reinterpret an accepted job. Packaging must describe the finished product, not an empty vessel or a dressing mixed in a jar. Partial blending or later solid additions cannot imply a completely smooth dish. Studio saves the settings before ordering a new hero; simply viewing a recipe does not save or generate anything.

Plates and bowls retain overhead photography. Cookware, platters, sauce boats, jars, bottles and drinking glasses use a view that shows their shape and contents, with the same lighting and isolated background. Final serving steps and toppings are included in the finished-dish prompt. Cookware masks preserve open handle gaps. Prompt evidence describes the completed transformations. Glass cutouts preserve their intentional transparency and cannot use ceramic enclosed-interior filling. The delivery canvas remains square, centred and proportional, including narrow bottle necks and closures. Subject matching and package identity include hero settings; ingredient and step photographs retain their separate identities.

Sauce boat masks may omit both the sauce surface and the opening inside the handle. Their correction restores only a clearly larger, broad food surface in the upper body and preserves smaller apertures. An ambiguous or open interior mask stops for review. The zero-cost aperture correction reuses the existing accepted SAM receipt and original source, without submitting another image or mask request.

## Individual photo instructions

The guided recipe editor offers **Zmień lub wygeneruj dowolne zdjęcie** for a finished dish, ingredient or preparation step. A natural-language brief creates a proposal that is reviewed and applied separately; publication remains an independent action. Explicit vessel settings are available in the same editor. Saving a changed presentation requires renewed content approval, while a one-off vessel direction in the photo brief does not modify the approved cooking text.

`regenerate: true` is an explicit manual photo request. Its immutable photography metadata prevents ingredient-library substitution both at admission and immediately before submission. Identical active requests still deduplicate and replay through their existing request key. A different pending ingredient producer blocks a new brief until settlement, preserving unique producer identity and uncertainty handling. Package generation continues to reuse the library by default.

A supported vessel requested in the brief is captured in `aiPhotography.heroPresentationOverride`, beside the unchanged approved recipe presentation. Image generation, cutout masking and subsequent corrections all use the same captured vessel; compact job polling reports it without exposing the full recipe input. The override is not a client-editable recipe field.

## Studio photograph packages

After reviewing a content proposal, **Zapisz szkic i generuj zdjęcia** first applies the checked text as a draft and starts a durable photograph package. The current saved recipe in Studio also offers **Generuj brakujące zdjęcia**. Packages capture the dish, ingredients and preparation steps, fill only missing photographs, and preserve existing media. Ingredient identity includes the required food form; matching library photographs and in-flight ingredient producers are reused instead of buying another photograph.

`photo-batch.ts` captures the complete package before dispatch. Queued package children do not occupy provider concurrency slots. Ingredients finish first, followed by preparation steps; the finished dish is photographed last. Earlier phases use the complete approved method and common photographic direction without a future hero reference. Packages and children have zero financial reservations; actual billing is recorded after confirmation. Uncertain submissions retain their existing receipt and never automatically repeat a paid POST.

Photo preflight and provider submission share `imageBrief` and its 32,000 Unicode-character prompt limit. This matches `prompt.maxLength` in the [Sunburst text-to-image OpenAPI schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=openai/gpt-image-2.5/sunburst/text-to-image) and the corresponding `/edit` endpoint (verified 2026-10-27). The former 8,000-byte full-prompt guard incorrectly rejected valid detailed recipes. Never truncate cooking steps, the approved presentation or the editor's instructions to satisfy that obsolete guard. The separate 8,000-byte editor-brief admission limit and 60,000-byte captured-input limit remain unchanged. A prompt above the provider limit still blocks the complete planned package before any new paid admission.

The package and child jobs remain visible after navigation or reload. A stopped or failed package resumes its existing work, preserving ready results and provider receipts while admitting only previously unsent photographs. **Zapisz zdjęcia w szkicu** checks the current food content and recipe revision, applies missing pictures together in one transaction, preserves photographs added by another editor, and never publishes the recipe.

Production schema rollout uses `npx tsx scripts/migrate-photo-batches.ts .env.production.local` to apply only `0008-ai-photo-batches`, under the existing migration lock.

## Verification

Run `NODE_OPTIONS=--conditions=react-server npx tsx --test src/server/ai/store.integration.test.ts` against the development direct Postgres connection. The suite creates and drops a unique isolated schema and uses provider placeholders; it makes no paid AI calls and changes no existing recipes or accounts. It exercises races, cost-only admission, replay, role changes, cancellations, immutable captures and results, private media, stale manual apply, public snapshot separation, and receipt accounting after account disable.

## Photo package recovery

A confirmed photo or mask failure remains attached to its slot while the remaining photographs continue. A settled package with failed slots exposes `PHOTO_BATCH_PARTIAL`; the administrator can apply only its ready photographs together, preserving revision, subject and existing-photo checks. Unknown provider acceptance still pauses the package before any new wave.

Resuming a previously stopped package preserves successful and accepted child jobs and re-reserves only the work that was never admitted. Origin reads protect freshly saved source files and uploads from cached missing-file responses; the media route falls back to origin before returning 404 for an authorized registered asset. Ingredient and preparation photos use the provider's `high` setting, while the main photo retains `xhigh`.

Ingredient and step phases proceed in waves of at most two distinct jobs under the existing global provider limit. Each phase finishes before the next begins; the final hero runs exclusively after those phases. Each wave settles its accepted children before the next wave starts; uncertainty prevents later paid submissions without discarding a successful sibling.

### Recovering a stopped worker

Studio offers **Sprawdź i wznów** for active packages and **Kontynuuj pakiet** for
stopped work. The server checks the recorded Workflow run: a live run wakes its
pending reads; a confirmed terminal or missing run can acquire a new generation.
The transaction matches the observed generation and run ID, and applies a
two-minute grace period before recovering a dispatch without its first claim.
Simultaneous checks cannot replace a newly claimed worker. Unknown engine status
never authorizes another worker. Dispatch IDs are recorded immediately after
`start()`, as well as at the worker claim.

Accepted provider receipts resume through reads, without the paid-submission
concurrency gate. Temporary reads have bounded durable retries. Storage failure
after generation preserves the receipt with a specific recoverable cause; an
unavailable billing read preserves the reservation and does not discard a ready
photo. A storage readiness check pauses manual continuation before new admission.

Manual receipt recovery runs in the authenticated Node request before falling
back to Workflow. A package continuation retrieves at most two children with a
recorded terminal provider receipt, no result, and the same immutable package ID.
It can recover a finished photograph while the worker is still retrying its
read. These recovery services expose no submission or admission operation;
immutable file checks and transactional result settlement also protect a
concurrent worker. Pending or unavailable reads retain the existing fallback.

Private photograph uploads pass a standard immutable `Blob` to the storage SDK.
The binary body copies the exact archive or presentation bytes and remains
readable across transport retries. Uploads keep their original private paths,
content types, SHA-256 comparison and `allowOverwrite: false` policy. Safe
diagnostics identify the read, encode, archive upload or presentation upload
stage without recording prompts, credentials, response bodies or full stacks.

An explicit continuation may retry a confirmed unsent preflight failure as a new
immutable attempt. Only allowlisted storage/reference errors with no provider
receipt and a settled zero charge qualify. The old job and ledger remain intact;
a deterministic attempt key, restored reservation and original package ceiling
protect retries across crashes or repeated clicks. Unknown provider acceptance
and actual failed delivered images never qualify for this resubmission.

### Retained hero alpha and mask candidates

Solid finished-dish photographs normalize only alpha endpoints. If a genuinely
isolated frame has one occupied corner, at least 10% transparent exterior and
90% clear perimeter, a small empty transparent margin preserves every delivered
pixel before the unchanged food-centre check. Opaque backgrounds and erased food
cannot qualify. New vessel prompts explicitly reserve room for long handles.

An accepted SAM recovery first checks the original generated alpha, so a sound
photograph is recovered without replacing food with a vessel-only mask. Other
returned masks are evaluated in score order against the same geometry checks.
The private accepted-response manifest and candidate files survive interrupted
reads; the first mask archive remains immutable and a validated selection uses
its own archive. Transient failures retry only GETs for that receipt.

Manual batch continuation can resume a strictly allowlisted, settled centre-loss
rejection through the existing authenticated source/approval checks. A package
whose children are all recovered becomes ready without another worker or paid
submission. Partial saving remains available alongside continuation.
