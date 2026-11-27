import { type Credential, type EndpointCheck, keys, useApi, useProbeEndpoint } from "@agenteschat/client";
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
  editNumber,
  emptyEndpointDraft,
  endpointAddressLooksValid,
  endpointBaseExample,
  endpointModelsOf,
  endpointReady,
  modelSummary,
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
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, TextInput, View } from "react-native";
import {
  Button,
  fieldText,
  GroupedField,
  GroupedFooter,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  IconButton,
  Locked,
  SearchField,
  Segmented,
  Text,
  useTheme,
} from "@/ui";
import { Note } from "./parts";

/**
 * "Outro provedor" on the phone (ADR 0146), the web's `EndpointForm`: a workspace's own OpenAI- or
 * Anthropic-compatible endpoint, its models fetched or typed, their prices, then saved with one test per model.
 * `onDone` gets the key with its models' tests just run; Concluir stays busy while what it returns runs.
 */
export function EndpointForm({
  orgId,
  credential,
  onDone,
  onCancel,
}: {
  orgId: string;
  credential?: Credential;
  onDone: (saved: Credential) => void | Promise<void>;
  onCancel?: () => void;
}) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const api = useApi();
  const qc = useQueryClient();
  const probe = useProbeEndpoint(orgId);
  const testAttachments = (credentialId: string, models: string[], force?: true) =>
    probe.mutate(
      { credentialId, models, ...(force ? { force } : {}) },
      {
        onSuccess: (result) =>
          setSaved((current) => {
            const endpoint = current?.key.endpoint;
            if (!current || !endpoint) return current;
            return { ...current, key: { ...current.key, endpoint: { ...endpoint, models: result.models } } };
          }),
      },
    );
  const [draft, setDraft] = useState<EndpointDraft>(() =>
    credential?.endpoint ? draftOfEndpoint(credential.label, credential.endpoint) : emptyEndpointDraft(),
  );
  const [typed, setTyped] = useState("");
  const [typedWrong, setTypedWrong] = useState(false);
  const [listing, setListing] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [saved, setSaved] = useState<{ key: Credential; checks: EndpointCheck[] } | null>(null);
  const [closing, setClosing] = useState(false);
  const [query, setQuery] = useState("");
  const [openModel, setOpenModel] = useState<string | null>(null);
  const [pinned, setPinned] = useState<ReadonlySet<string>>(new Set());
  const search = (next: string) => {
    setPinned(new Set(draft.models.filter((m) => m.on).map((m) => m.id)));
    setQuery(next);
  };
  const searching = draft.models.length > ENDPOINT_SEARCH_FROM;
  const shown = searching ? modelsShown(draft.models, query, pinned) : draft.models;
  const set = (patch: Partial<EndpointDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const setModel = (id: string, patch: Partial<EndpointDraft["models"][number]>) =>
    setDraft((d) => ({ ...d, models: d.models.map((m) => (m.id === id ? { ...m, ...patch } : m)) }));
  const input = [fieldText("callout"), styles.input, { color: c.ink }];
  const locked = saving || listing;

  const fetchModels = async () => {
    const requestedBaseURL = draft.baseURL.trim();
    setListing(true);
    setListError(null);
    try {
      const r = await api.agents.endpointModels(
        orgId,
        credential
          ? { credentialId: credential.id }
          : {
              baseURL: draft.baseURL.trim(),
              apiKey: draft.apiKey.trim() || undefined,
            },
      );
      setDraft((d) =>
        credential || d.baseURL.trim() === requestedBaseURL
          ? {
              ...withListedModels(d, r.models),
              baseURL: r.baseURL,
              listingStyle: r.listingStyle ?? d.listingStyle,
            }
          : d,
      );
      setListError(r.error ?? null);
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error));
    } finally {
      setListing(false);
    }
  };
  const addTyped = () => {
    const next = withTypedModel(draft, typed);
    setTypedWrong(next === null);
    if (!next) return;
    setDraft(next);
    setTyped("");
  };
  const save = async () => {
    const models = endpointModelsOf(draft);
    if (!models || saving) return;
    setSaving(true);
    setFailed(false);
    try {
      let key: Credential;
      let checks: EndpointCheck[];
      if (credential?.endpoint) {
        const result = await api.agents.setEndpointModels(orgId, credential.id, models, draft.listingStyle);
        key = {
          ...credential,
          endpoint: {
            ...credential.endpoint,
            ...(draft.listingStyle ? { listingStyle: draft.listingStyle } : {}),
            models: result.models,
          },
        };
        checks = result.checks;
      } else {
        const { checks: result, ...added } = await api.agents.addCredential(orgId, {
          provider: CUSTOM_PROVIDER,
          label: draft.name.trim(),
          apiKey: draft.apiKey.trim(),
          endpoint: {
            style: draft.style,
            ...(draft.listingStyle ? { listingStyle: draft.listingStyle } : {}),
            baseURL: draft.baseURL.trim(),
            models,
          },
        });
        key = added;
        checks = result ?? [];
      }
      const checked = withChecks(key, checks);
      setSaved({ key: checked, checks });
      const pending = checked.endpoint?.models.filter((m) => pendingAttachments(m).length).map((m) => m.id);
      if (pending?.length) testAttachments(key.id, pending);
      await qc.invalidateQueries({ queryKey: keys.credentials(orgId) });
      void qc.invalidateQueries({ queryKey: keys.models });
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  if (saved) {
    const models = saved.key.endpoint?.models ?? [];
    return (
      <View style={styles.gap}>
        {saved.key.reused ? (
          <Note icon="check" live inset>
            {t("settings.keyResaved")}
          </Note>
        ) : null}
        <GroupedHeader>{t("endpoint.results")}</GroupedHeader>
        <GroupedList>
          {checksInOrder(draft, saved.checks).map((r) => (
            <GroupedRow
              key={r.model}
              icon={CHECK_VIEW[r.check].tone === "ok" ? "check" : CHECK_VIEW[r.check].tone === "warn" ? "info" : "x"}
              label={r.model}
              sub={t(CHECK_VIEW[r.check].key, { error: r.error ?? "" })}
              subLines={3}
            />
          ))}
        </GroupedList>
        {models.map((model) => (
          <GroupedList key={model.id}>
            {ENDPOINT_ATTACHMENTS.map((field) => {
              const testing =
                probe.isPending &&
                probe.variables.models?.includes(model.id) &&
                pendingAttachments(model, probe.variables.force).includes(field);
              return (
                <GroupedRow
                  key={field}
                  label={`${model.id} · ${t(`endpoint.capabilities.${field}`)}`}
                  value={t(testing ? "endpoint.capabilities.testing" : attachmentLabel(attachmentValue(model, field)))}
                />
              );
            })}
            <GroupedRow
              label={t("endpoint.capabilities.retest")}
              onPress={
                probe.isPending || !pendingAttachments(model, true).length
                  ? undefined
                  : () => testAttachments(saved.key.id, [model.id], true)
              }
            />
          </GroupedList>
        ))}
        {probe.isError && (
          <Note icon="x" live inset>
            {t("endpoint.capabilities.failed")}
          </Note>
        )}
        <Button
          variant="primary"
          wide
          label={t("endpoint.done")}
          loading={closing}
          disabled={closing}
          onPress={async () => {
            setClosing(true);
            try {
              await onDone(saved.key);
            } finally {
              setClosing(false);
            }
          }}
        />
      </View>
    );
  }

  return (
    <View style={styles.gap}>
      {!credential && (
        <Locked when={locked} style={styles.gap}>
          <GroupedList>
            <GroupedField label={t("endpoint.name")}>
              <TextInput
                value={draft.name}
                onChangeText={(name) => set({ name })}
                placeholder={t("endpoint.namePlaceholder")}
                placeholderTextColor={c.faint}
                maxLength={80}
                autoCorrect={false}
                accessibilityLabel={t("endpoint.name")}
                style={input}
              />
            </GroupedField>
          </GroupedList>
          <GroupedList>
            <GroupedField label={t("endpoint.address")}>
              <TextInput
                value={draft.baseURL}
                onChangeText={(baseURL) => setDraft((d) => withEndpointAddress(d, baseURL))}
                placeholder={endpointBaseExample(draft.style)}
                placeholderTextColor={c.faint}
                keyboardType="url"
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                accessibilityLabel={t("endpoint.address")}
                style={input}
              />
            </GroupedField>
            <GroupedField
              label={t("endpoint.key")}
              hint={{ name: t("common.about", { label: t("endpoint.key") }), text: t("endpoint.keyHelp") }}
            >
              <TextInput
                value={draft.apiKey}
                onChangeText={(apiKey) => set({ apiKey })}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel={t("endpoint.key")}
                style={input}
              />
            </GroupedField>
          </GroupedList>
          <GroupedFooter>{t("endpoint.addressHelp", { example: endpointBaseExample(draft.style) })}</GroupedFooter>
        </Locked>
      )}
      {/* Fetching from the provider is the way in, so it heads the list. Typing an id is the fallback under it. */}
      <GroupedHeader
        aside={
          <Button
            variant="text"
            size="sm"
            label={t("endpoint.fetch")}
            loading={listing}
            disabled={locked || (!credential && !endpointAddressLooksValid(draft.baseURL))}
            onPress={() => void fetchModels()}
          />
        }
      >
        {t("endpoint.choose")}
      </GroupedHeader>
      <Locked when={locked} style={styles.gap}>
        {listError ? (
          <Note icon="x" inset>
            {t("endpoint.listFailed", { error: listError })}
          </Note>
        ) : null}
        {draft.models.length > 0 ? (
          <>
            {searching ? (
              <SearchField
                value={query}
                onChangeText={search}
                placeholder={t("endpoint.search")}
                accessibilityLabel={t("endpoint.search")}
                raised
              />
            ) : null}
            {shown.length === 0 ? (
              <GroupedFooter>{t("endpoint.noMatch", { query: query.trim() })}</GroupedFooter>
            ) : (
              <View style={styles.gap}>
                {shown.map((m) => (
                  <View key={m.id} style={styles.gap}>
                    <GroupedList>
                      <GroupedRow
                        label={m.id}
                        labelLines={0}
                        sub={modelSummary(m, t)}
                        subLines={0}
                        expanded={openModel === m.id}
                        onPress={() => {
                          setModel(m.id, { on: true });
                          setOpenModel((open) => (open === m.id ? null : m.id));
                        }}
                        buttons={[
                          {
                            icon: m.on ? "check" : "plus",
                            label: t(m.on ? "endpoint.deselectModel" : "endpoint.selectModel", { model: m.id }),
                            onPress: () => {
                              setModel(m.id, { on: !m.on });
                              if (m.on) setOpenModel((open) => (open === m.id ? null : open));
                            },
                          },
                        ]}
                      />
                    </GroupedList>
                    {openModel === m.id ? (
                      <>
                        <GroupedHeader>{m.id}</GroupedHeader>
                        <GroupedList>
                          <GroupedField label={t("endpoint.capabilities.api")} stacked>
                            <GroupedList>
                              {[
                                {
                                  value: "auto" as const,
                                  label: `${t("endpoint.capabilities.automatic")} · ${m.discovered?.api ? ENDPOINT_API_LABELS[m.discovered.api.value] : t("endpoint.capabilities.apiFallback", { api: ENDPOINT_API_LABELS[draft.style === "anthropic" ? "messages" : "chat"] })}`,
                                },
                                ...Object.entries(ENDPOINT_API_LABELS).map(([value, label]) => ({
                                  value: value as keyof typeof ENDPOINT_API_LABELS,
                                  label,
                                })),
                              ].map(({ value, label }) => (
                                <GroupedRow
                                  key={value}
                                  label={label}
                                  checked={(m.manual?.api ?? "auto") === value}
                                  onPress={() =>
                                    setModel(m.id, {
                                      manual: { ...m.manual, api: value === "auto" ? undefined : value },
                                    })
                                  }
                                />
                              ))}
                            </GroupedList>
                          </GroupedField>
                        </GroupedList>
                        {[ENDPOINT_LIMITS, ENDPOINT_PRICES].map((fields, index) => (
                          <View key={fields[0]}>
                            <GroupedHeader>
                              {t(index === 0 ? "endpoint.modelLimits" : "endpoint.modelPrices")}
                            </GroupedHeader>
                            <GroupedList>
                              {fields.map((field) => {
                                const limit = index === 0;
                                const manual = m.manual?.[field];
                                const auto = discoveredNumber(m, field);
                                const invalid =
                                  manual !== undefined && (limit ? parseLimit(manual) : parsePrice(manual)) === null;
                                const label = t(numberFieldLabel(field));
                                return (
                                  <GroupedField key={field} label={label} stacked>
                                    <TextInput
                                      value={manual ?? (auto === undefined ? "" : String(auto))}
                                      onChangeText={(v) => setModel(m.id, { manual: editNumber(m, field, v) })}
                                      keyboardType={limit ? "number-pad" : "decimal-pad"}
                                      placeholder={t("endpoint.capabilities.unknown")}
                                      placeholderTextColor={c.faint}
                                      accessibilityLabel={`${m.id} · ${label}`}
                                      style={input}
                                    />
                                    {manual !== undefined && (
                                      <Button
                                        variant="text"
                                        size="sm"
                                        label={`${t("endpoint.capabilities.manual")} · ${t("endpoint.capabilities.reset")}`}
                                        onPress={() => setModel(m.id, { manual: { ...m.manual, [field]: undefined } })}
                                      />
                                    )}
                                    {invalid && (
                                      <Text variant="footnote" tone="danger" accessibilityLiveRegion="polite">
                                        {t(limit ? "endpoint.capabilities.invalidLimit" : "endpoint.priceInvalid")}
                                      </Text>
                                    )}
                                  </GroupedField>
                                );
                              })}
                            </GroupedList>
                            {index === 1 ? <GroupedFooter>{t("endpoint.priceUnit")}</GroupedFooter> : null}
                          </View>
                        ))}
                        <GroupedHeader>{t("endpoint.modelAttachments")}</GroupedHeader>
                        <GroupedList>
                          {ENDPOINT_ATTACHMENTS.map((field) => {
                            const auto = m.discovered?.[field]?.value;
                            const manual = m.manual?.[field];
                            return (
                              <GroupedField key={field} label={t(`endpoint.capabilities.${field}`)} stacked>
                                <Segmented
                                  wide
                                  value={manual === undefined ? "auto" : String(manual)}
                                  items={[
                                    { key: "auto", label: t("endpoint.capabilities.automatic") },
                                    { key: "true", label: t("endpoint.capabilities.yes") },
                                    { key: "false", label: t("endpoint.capabilities.no") },
                                  ]}
                                  onChange={(value) =>
                                    setModel(m.id, {
                                      manual: { ...m.manual, [field]: value === "auto" ? undefined : value === "true" },
                                    })
                                  }
                                />
                                <Text variant="footnote">
                                  {t(manual === undefined ? attachmentLabel(auto) : "endpoint.capabilities.manual")}
                                </Text>
                              </GroupedField>
                            );
                          })}
                        </GroupedList>
                        {m.typed ? (
                          <GroupedList>
                            <GroupedRow
                              icon="x"
                              label={t("common.removeName", { name: m.id })}
                              labelLines={0}
                              danger
                              onPress={() => {
                                setDraft((d) => withoutModel(d, m.id));
                                setOpenModel((open) => (open === m.id ? null : open));
                              }}
                            />
                          </GroupedList>
                        ) : null}
                      </>
                    ) : null}
                  </View>
                ))}
              </View>
            )}
          </>
        ) : null}
        {/* With nothing listed yet the field sits right under the list's header, which already says what it's for. */}
        {draft.models.length > 0 ? <GroupedHeader>{t("endpoint.addModel")}</GroupedHeader> : null}
        <GroupedList>
          <GroupedField label={t("endpoint.models")}>
            <View style={styles.addRow}>
              <TextInput
                value={typed}
                onChangeText={(v) => {
                  setTyped(v);
                  setTypedWrong(false);
                }}
                placeholder={t("endpoint.modelPlaceholder")}
                placeholderTextColor={c.faint}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                returnKeyType="done"
                onSubmitEditing={addTyped}
                accessibilityLabel={t("endpoint.addModel")}
                style={input}
              />
              <IconButton icon="plus" label={t("endpoint.add")} disabled={!typed.trim()} onPress={addTyped} />
            </View>
          </GroupedField>
        </GroupedList>
        {/* Under the field, on the footers' edge: what it said about what was typed. */}
        {typedWrong ? (
          <GroupedFooter>
            <Text variant="footnote" tone="danger" accessibilityLiveRegion="polite">
              {t("endpoint.modelInvalid")}
            </Text>
          </GroupedFooter>
        ) : null}
      </Locked>
      {draft.models.some((m) => m.on && modelUnpricedInDraft(m)) ? (
        <Note icon="info" inset>
          {t("endpoint.unpriced")}
        </Note>
      ) : null}
      {failed ? (
        <Note icon="x" live inset>
          {t("mobile.ai.failed")}
        </Note>
      ) : null}
      <Button
        variant="primary"
        wide
        label={saving ? t("endpoint.testing") : t(credential ? "endpoint.saveModels" : "endpoint.save")}
        loading={saving}
        disabled={!endpointReady(draft) || listing}
        onPress={() => void save()}
      />
      {onCancel ? (
        <Button variant="ghost" wide label={t("common.cancel")} disabled={saving} onPress={onCancel} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  gap: { gap: 12 },
  addRow: { flexDirection: "row", alignItems: "center" },
  input: { flex: 1, paddingVertical: 12, paddingHorizontal: 0 },
});
