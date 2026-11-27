import type { Credential, EndpointCheck } from "@agenteschat/client";
import { useAddCredential, useEndpointModels, useProbeEndpoint, useSetEndpointModels } from "@agenteschat/client";
import {
  attachmentLabel,
  attachmentValue,
  CHECK_VIEW,
  CUSTOM_PROVIDER,
  checksInOrder,
  discoveredNumber,
  draftOfEndpoint,
  ENDPOINT_API_LABELS,
  ENDPOINT_ATTACHMENTS,
  ENDPOINT_LIMITS,
  ENDPOINT_PRICES,
  ENDPOINT_SEARCH_FROM,
  type EndpointDraft,
  type EndpointModelDraft,
  editNumber,
  emptyEndpointDraft,
  endpointAddressLooksValid,
  endpointBaseExample,
  endpointModelsOf,
  endpointReady,
  modelsShown,
  modelUnpricedInDraft,
  numberFieldLabel,
  parseLimit,
  parsePrice,
  pendingAttachments,
  withChecks,
  withEndpointAddress,
  withListedModels,
  withoutModel,
  withTypedModel,
} from "@agenteschat/client/lib/endpoints";
import {
  AffixInput,
  Button,
  Checkbox,
  DialogBody,
  DialogFooter,
  Field,
  FormActions,
  FormStack,
  Icon,
  Input,
  Locked,
  SearchField,
  Segmented,
  Select,
  SettingNote,
  Spinner,
} from "@agenteschat/ui";
import { type ReactNode, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * "Outro provedor" (ADR 0146): a workspace's own OpenAI- or Anthropic-compatible endpoint. The admin names it, picks
 * its API, types its address and key, fetches its models (or types their ids), chooses which agents may use and their
 * prices, then saves: the server runs one test call per model and the results show here. With `credential`, it
 * changes a saved endpoint's models and prices (its address and key stay). With `onCancel` it fills a dialog, its
 * body and footer; without, it is a block of a panel whose action comes up under it once there's something to save,
 * like the panel's own Salvar chave. `onDone` gets the key with its models' tests just run.
 */
export function EndpointForm({
  orgId,
  credential,
  lead,
  onCancel,
  onDone,
}: {
  orgId: string;
  credential?: Credential;
  /** The form's first field, owned by the caller (the provider's select): locked and laid out with the rest. */
  lead?: ReactNode;
  onCancel?: () => void;
  /** Its button stays busy while what it returns runs (the caller putting the key on an agent). */
  onDone: (saved: Credential) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const ids = useId();
  const [draft, setDraft] = useState<EndpointDraft>(() =>
    credential?.endpoint ? draftOfEndpoint(credential.label, credential.endpoint) : emptyEndpointDraft(),
  );
  const [typed, setTyped] = useState("");
  const [typedWrong, setTypedWrong] = useState(false);
  const typedBox = useRef<HTMLInputElement>(null);
  const [saved, setSaved] = useState<{ cred: Credential; checks: EndpointCheck[] } | null>(null);
  const [closing, setClosing] = useState(false);
  const [query, setQuery] = useState("");
  const [pinned, setPinned] = useState<ReadonlySet<string>>(new Set());
  const search = (next: string) => {
    setPinned(new Set(draft.models.filter((m) => m.on).map((m) => m.id)));
    setQuery(next);
  };
  const searching = draft.models.length > ENDPOINT_SEARCH_FROM;
  const shown = searching ? modelsShown(draft.models, query, pinned) : draft.models;
  const list = useEndpointModels(orgId);
  const add = useAddCredential(orgId);
  const change = useSetEndpointModels(orgId);
  const probe = useProbeEndpoint(orgId);
  const testAttachments = (credentialId: string, models: string[], force?: true) =>
    probe.mutate(
      { credentialId, models, ...(force ? { force } : {}) },
      {
        onSuccess: (result) =>
          setSaved((current) => {
            const endpoint = current?.cred.endpoint;
            if (!current || !endpoint) return current;
            return { ...current, cred: { ...current.cred, endpoint: { ...endpoint, models: result.models } } };
          }),
      },
    );
  const editing = credential !== undefined;
  const set = (patch: Partial<EndpointDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const setModel = (id: string, patch: Partial<EndpointDraft["models"][number]>) =>
    setDraft((d) => ({ ...d, models: d.models.map((m) => (m.id === id ? { ...m, ...patch } : m)) }));
  const addTyped = () => {
    const next = withTypedModel(draft, typed);
    setTypedWrong(next === null);
    if (!next) return;
    setDraft(next);
    setTyped("");
    // The + turns off with the field empty, and a × leaves with its row: the keyboard stays in the form.
    typedBox.current?.focus();
  };
  const fetchModels = () => {
    const input = credential
      ? { credentialId: credential.id }
      : {
          baseURL: draft.baseURL.trim(),
          apiKey: draft.apiKey.trim() || undefined,
        };
    list.mutate(input, {
      onSuccess: (r) =>
        setDraft((d) =>
          credential || d.baseURL.trim() === input.baseURL
            ? {
                ...withListedModels(d, r.models),
                baseURL: r.baseURL,
                listingStyle: r.listingStyle ?? d.listingStyle,
              }
            : d,
        ),
    });
  };
  const showResults = (cred: Credential, checks: EndpointCheck[]) => {
    const checked = withChecks(cred, checks);
    setSaved({ cred: checked, checks });
    const models = checked.endpoint?.models.filter((m) => pendingAttachments(m).length).map((m) => m.id);
    if (models?.length) testAttachments(cred.id, models);
  };
  const save = () => {
    const models = endpointModelsOf(draft);
    if (!models) return;
    if (editing && credential) {
      change.mutate(
        { credentialId: credential.id, models, listingStyle: draft.listingStyle },
        {
          onSuccess: (r) =>
            showResults(
              {
                ...credential,
                ...(credential.endpoint
                  ? {
                      endpoint: {
                        ...credential.endpoint,
                        ...(draft.listingStyle ? { listingStyle: draft.listingStyle } : {}),
                        models: r.models,
                      },
                    }
                  : {}),
              },
              r.checks,
            ),
        },
      );
      return;
    }
    add.mutate(
      {
        provider: CUSTOM_PROVIDER,
        label: draft.name.trim(),
        apiKey: draft.apiKey.trim(),
        endpoint: {
          style: draft.style,
          ...(draft.listingStyle ? { listingStyle: draft.listingStyle } : {}),
          baseURL: draft.baseURL.trim(),
          models,
        },
      },
      { onSuccess: ({ checks, ...cred }) => showResults(cred, checks ?? []) },
    );
  };
  const saving = add.isPending || change.isPending;
  const locked = saving || list.isPending;
  const resultModels = saved?.cred.endpoint?.models ?? [];
  const setManual = (m: EndpointModelDraft, manual: EndpointModelDraft["manual"]) => setModel(m.id, { manual });
  const ready = editing ? endpointModelsOf(draft) !== null : endpointReady(draft);
  const unpriced = draft.models.some((m) => m.on && modelUnpricedInDraft(m));

  const Body = onCancel ? DialogBody : FormStack;
  const Foot = onCancel ? DialogFooter : FormActions;

  if (saved) {
    return (
      <>
        <Body>
          {saved.cred.reused && (
            <SettingNote icon="check" live>
              {t("settings.keyResaved")}
            </SettingNote>
          )}
          <b>{t("endpoint.results")}</b>
          <ul className="ac-iconlist endpoint-checks">
            {checksInOrder(draft, saved.checks).map((c) => {
              const view = CHECK_VIEW[c.check];
              return (
                <li key={c.model} className="ac-iconline">
                  <Icon name={view.tone === "ok" ? "check" : "alert"} size={14} />
                  <span>
                    <b>{c.model}</b> · {t(view.key, { error: c.error ?? "" })}
                  </span>
                </li>
              );
            })}
          </ul>
          {resultModels.map((model) => (
            <div className="ac-iconline endpoint-attachments" key={model.id} aria-live="polite">
              <b>{model.id}</b>
              {ENDPOINT_ATTACHMENTS.map((field) => {
                const testing =
                  probe.isPending &&
                  probe.variables.models?.includes(model.id) &&
                  pendingAttachments(model, probe.variables.force).includes(field);
                return (
                  <span className="ac-field__example" key={field}>
                    {t(`endpoint.capabilities.${field}`)} ·{" "}
                    {t(testing ? "endpoint.capabilities.testing" : attachmentLabel(attachmentValue(model, field)))}
                  </span>
                );
              })}
              <Button
                size="sm"
                disabled={probe.isPending || pendingAttachments(model, true).length === 0}
                onClick={() => testAttachments(saved.cred.id, [model.id], true)}
              >
                {t("endpoint.capabilities.retest")}
              </Button>
            </div>
          ))}
          {probe.isError && <SettingNote icon="alert">{t("endpoint.capabilities.failed")}</SettingNote>}
        </Body>
        <Foot>
          <Button
            variant="primary"
            loading={closing}
            disabled={closing}
            onClick={async () => {
              setClosing(true);
              try {
                await onDone(saved.cred);
              } finally {
                setClosing(false);
              }
            }}
          >
            {t("endpoint.done")}
          </Button>
        </Foot>
      </>
    );
  }

  return (
    <>
      <Locked when={locked}>
        <Body>
          {lead}
          {!editing && (
            <>
              <Field label={t("endpoint.name")} id={`${ids}-name`}>
                <Input
                  value={draft.name}
                  maxLength={80}
                  placeholder={t("endpoint.namePlaceholder")}
                  onChange={(e) => set({ name: e.target.value })}
                />
              </Field>
              <Field
                label={t("endpoint.address")}
                id={`${ids}-url`}
                example={t("endpoint.addressHelp", { example: endpointBaseExample(draft.style) })}
              >
                <Input
                  value={draft.baseURL}
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={endpointBaseExample(draft.style)}
                  onChange={(e) => setDraft((d) => withEndpointAddress(d, e.target.value))}
                />
              </Field>
              <Field
                label={t("endpoint.key")}
                id={`${ids}-key`}
                hint={{ name: t("common.about", { label: t("endpoint.key") }), text: t("endpoint.keyHelp") }}
              >
                <Input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={draft.apiKey}
                  onChange={(e) => set({ apiKey: e.target.value })}
                />
              </Field>
            </>
          )}
          <Field
            label={t("endpoint.addModel")}
            id={`${ids}-typed`}
            error={typedWrong ? t("endpoint.modelInvalid") : undefined}
            labelAside={
              <button
                type="button"
                className="ac-link ac-link--muted small"
                aria-busy={list.isPending || undefined}
                disabled={locked || (!editing && !endpointAddressLooksValid(draft.baseURL))}
                onClick={fetchModels}
              >
                <span className="ac-iconline">
                  {list.isPending && <Spinner size={12} />}
                  {t("endpoint.fetch")}
                </span>
              </button>
            }
          >
            <AffixInput
              ref={typedBox}
              value={typed}
              spellCheck={false}
              autoComplete="off"
              placeholder={t("endpoint.modelPlaceholder")}
              invalid={typedWrong}
              action={
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  icon="plus"
                  aria-label={t("endpoint.add")}
                  disabled={!typed.trim()}
                  onClick={addTyped}
                />
              }
              onChange={(e) => {
                setTyped(e.target.value);
                setTypedWrong(false);
              }}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                addTyped();
              }}
            />
          </Field>
          {(list.data?.error || list.error) && (
            <SettingNote icon="alert">
              {t("endpoint.listFailed", { error: list.data?.error ?? list.error?.message ?? "" })}
            </SettingNote>
          )}
          {draft.models.length > 0 && (
            <fieldset className="endpoint-models" aria-labelledby={`${ids}-choose`}>
              <span className="ac-field__label" id={`${ids}-choose`}>
                {t("endpoint.choose")}
              </span>
              {searching && (
                <SearchField
                  aria-label={t("endpoint.search")}
                  placeholder={t("endpoint.search")}
                  value={query}
                  onChange={(e) => search(e.target.value)}
                  onClear={() => search("")}
                  clearLabel={t("filters.clearSearch")}
                />
              )}
              {searching && shown.length === 0 && (
                <SettingNote icon="search">{t("endpoint.noMatch", { query: query.trim() })}</SettingNote>
              )}
              {shown.map((m) => {
                return (
                  <div key={m.id} className="endpoint-model">
                    <Checkbox id={`${ids}-m-${m.id}`} checked={m.on} onCheckedChange={(on) => setModel(m.id, { on })} />
                    <label htmlFor={`${ids}-m-${m.id}`}>{m.id}</label>
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      icon="close"
                      aria-label={t("common.removeName", { name: m.id })}
                      onClick={() => {
                        setDraft((d) => withoutModel(d, m.id));
                        typedBox.current?.focus();
                      }}
                    />
                    {m.on && (
                      <div className="endpoint-model__capabilities">
                        <Field label={t("endpoint.capabilities.api")} id={`${ids}-${m.id}-api`}>
                          <Select
                            aria-label={`${m.id} · ${t("endpoint.capabilities.api")}`}
                            value={m.manual?.api ?? "auto"}
                            options={[
                              {
                                value: "auto",
                                label: `${t("endpoint.capabilities.automatic")} · ${m.discovered?.api ? ENDPOINT_API_LABELS[m.discovered.api.value] : t("endpoint.capabilities.apiFallback", { api: ENDPOINT_API_LABELS[draft.style === "anthropic" ? "messages" : "chat"] })}`,
                              },
                              ...Object.entries(ENDPOINT_API_LABELS).map(([value, label]) => ({ value, label })),
                            ]}
                            onValueChange={(value) =>
                              setManual(m, {
                                ...m.manual,
                                api: value === "auto" ? undefined : (value as keyof typeof ENDPOINT_API_LABELS),
                              })
                            }
                          />
                        </Field>
                        {[...ENDPOINT_LIMITS, ...ENDPOINT_PRICES].map((field, index) => {
                          const limit = index < ENDPOINT_LIMITS.length;
                          const manual = m.manual?.[field];
                          const auto = discoveredNumber(m, field);
                          const invalid =
                            manual !== undefined && (limit ? parseLimit(manual) : parsePrice(manual)) === null;
                          const label = t(numberFieldLabel(field));
                          return (
                            <Field
                              key={field}
                              label={label}
                              id={`${ids}-${m.id}-${field}`}
                              error={
                                invalid
                                  ? t(limit ? "endpoint.capabilities.invalidLimit" : "endpoint.priceInvalid")
                                  : undefined
                              }
                              labelAside={
                                manual === undefined ? undefined : (
                                  <button
                                    type="button"
                                    className="ac-link ac-link--muted small"
                                    aria-label={`${label} · ${t("endpoint.capabilities.reset")}`}
                                    onClick={() => setManual(m, { ...m.manual, [field]: undefined })}
                                  >
                                    {t("endpoint.capabilities.manual")} · {t("endpoint.capabilities.reset")}
                                  </button>
                                )
                              }
                            >
                              <Input
                                value={manual ?? auto ?? ""}
                                inputMode={limit ? "numeric" : "decimal"}
                                placeholder={t("endpoint.capabilities.unknown")}
                                aria-label={
                                  field === "input" || field === "output"
                                    ? t(field === "input" ? "endpoint.priceIn" : "endpoint.priceOut", { model: m.id })
                                    : `${m.id} · ${label}`
                                }
                                onChange={(e) => setManual(m, editNumber(m, field, e.target.value))}
                              />
                            </Field>
                          );
                        })}
                        {ENDPOINT_ATTACHMENTS.map((field) => {
                          const auto = m.discovered?.[field]?.value;
                          const manual = m.manual?.[field];
                          const label = t(`endpoint.capabilities.${field}`);
                          return (
                            <Field key={field} label={label} group>
                              <Segmented
                                label={`${m.id} · ${label}`}
                                value={manual === undefined ? "auto" : String(manual)}
                                options={[
                                  { value: "auto", label: t("endpoint.capabilities.automatic") },
                                  { value: "true", label: t("endpoint.capabilities.yes") },
                                  { value: "false", label: t("endpoint.capabilities.no") },
                                ]}
                                onValueChange={(value) =>
                                  setManual(m, {
                                    ...m.manual,
                                    [field]: value === "auto" ? undefined : value === "true",
                                  })
                                }
                              />
                              <span className="ac-field__example">
                                {t(manual === undefined ? attachmentLabel(auto) : "endpoint.capabilities.manual")}
                              </span>
                            </Field>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
              {draft.models.some((m) => m.on) && <span className="ac-field__example">{t("endpoint.priceUnit")}</span>}
            </fieldset>
          )}
          {unpriced && <SettingNote icon="info">{t("endpoint.unpriced")}</SettingNote>}
        </Body>
      </Locked>
      {(onCancel || ready || saving) && (
        <Foot note={saving ? t("endpoint.testing") : undefined}>
          {onCancel && (
            <Button onClick={onCancel} disabled={saving}>
              {t("common.cancel")}
            </Button>
          )}
          <Button variant="primary" loading={saving} disabled={!ready || locked} onClick={save}>
            {t(editing ? "endpoint.saveModels" : "endpoint.save")}
          </Button>
        </Foot>
      )}
    </>
  );
}
