import type { Credential, DecisionSettings, DecisionSettingsView } from "@agenteschat/client";
import {
  useCredentials,
  useDecisionSettings,
  useResetDecisionSettings,
  useSaveDecisionSettings,
} from "@agenteschat/client";
import {
  credentialRowOf,
  decisionCredentials,
  decisionDraftOf,
  decisionEndpointOf,
  decisionInputOf,
  decisionModelIdValid,
  decisionModeOf,
} from "@agenteschat/client/lib/decisions";
import { errorCode, errorText } from "@agenteschat/client/lib/errors";
import { can } from "@agenteschat/client/lib/permissions";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, TextInput, View } from "react-native";
import { useOrg } from "@/providers/org";
import {
  Button,
  fieldText,
  GroupedField,
  GroupedHeader,
  GroupedList,
  GroupedRow,
  ProviderLogo,
  Segmented,
  Text,
  useTheme,
} from "@/ui";
import { confirmAction } from "../settings/parts";
import { type PickOption, pickOne } from "../shared/PickerSheet";
import { Note } from "./parts";

type Mode = "jev" | "openrouter" | "custom";
type ProviderMode = Exclude<Mode, "jev">;

interface ProviderDraft {
  credentialId: string;
  model: string;
  visionModel: string;
  endpoint: string;
}

const OTHER_MODEL = "\u0000other";
const OPENROUTER_MODELS = [
  { value: "typesafe/jev-1.14", label: "Jev 1.14" },
  { value: "jaredpalmer/kev-4b", label: "Kev 4B" },
] as const;
const OPENROUTER_VISION = OPENROUTER_MODELS.slice(0, 1);
const OPENROUTER_DEFAULT = OPENROUTER_MODELS[0].value;
const OPENROUTER_VISION_DEFAULT = OPENROUTER_VISION[0].value;

/** An endpoint override belongs to Custom only, so this refusal says that instead of the generic address line. */
const decisionErrorText = (t: TFunction, error: unknown): string =>
  errorCode(error) === "decision_endpoint_unsupported" ? t("jev.decision.error.endpoint") : errorText(t, error);

const providerOf = (mode: Mode): ProviderMode | null => (mode === "jev" ? null : mode);

const modelChoices = (credential: Credential | undefined) =>
  (credential?.endpoint?.models ?? []).map((model) => ({
    value: model.id,
    label: model.label ?? model.id,
    sub: model.label ? model.id : undefined,
  }));

const initialDrafts = (
  settings: DecisionSettings | null,
  current: Credential | undefined,
  eligible: readonly Credential[],
  savedMode: Mode,
): Record<ProviderMode, ProviderDraft> => {
  const openRouter = eligible.find((credential) => credential.provider === "openrouter");
  const custom = eligible.find((credential) => credential.provider === "custom");
  const customModels = modelChoices(custom);
  const saved = decisionDraftOf(settings);
  // A copy's `copyOf` row stands for both; a removed account keeps its id so the row stays unavailable.
  const savedId = current?.id ?? saved.credentialId;
  return {
    openrouter: {
      credentialId: savedMode === "openrouter" ? savedId : (openRouter?.id ?? ""),
      model: savedMode === "openrouter" ? saved.model : OPENROUTER_DEFAULT,
      visionModel: savedMode === "openrouter" ? saved.visionModel : openRouter ? OPENROUTER_VISION_DEFAULT : "",
      endpoint: "",
    },
    custom: {
      credentialId: savedMode === "custom" ? savedId : (custom?.id ?? ""),
      model: savedMode === "custom" ? saved.model : (customModels[0]?.value ?? ""),
      visionModel: savedMode === "custom" ? saved.visionModel : (customModels[0]?.value ?? ""),
      endpoint: savedMode === "custom" ? saved.endpoint : "",
    },
  };
};

const knownModel = (mode: Mode, value: string, credential: Credential | undefined): boolean => {
  const choices = mode === "openrouter" ? OPENROUTER_MODELS : modelChoices(credential);
  return value === "" || choices.some((model) => model.value === value);
};

/**
 * A workspace's decision models (ADR 0195) on the phone: one card and one provider choice, using credentials already
 * registered above. Jev keeps the installation's setup. OpenRouter and custom endpoints carry no key or address
 * registration here; a custom endpoint's full address is an optional advanced override.
 */
export function DecisionSettingsCard() {
  const { org, orgId } = useOrg();
  const allowed = can(org, "manage_credentials");
  const view = useDecisionSettings(orgId, allowed);
  const credentials = useCredentials(orgId, allowed);
  if (!allowed || !view.isSuccess || !credentials.isSuccess) return null;
  return <DecisionForm orgId={orgId} view={view.data} credentials={credentials.data} />;
}

function DecisionForm({
  orgId,
  view,
  credentials,
}: {
  orgId: string;
  view: DecisionSettingsView;
  credentials: readonly Credential[];
}) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const save = useSaveDecisionSettings(orgId);
  const reset = useResetDecisionSettings(orgId);
  const settings = view.settings;
  const current = credentialRowOf(credentials, settings?.credentialId);
  const eligible = decisionCredentials(credentials);
  const savedMode = decisionModeOf(settings, credentials) ?? (settings ? "custom" : "jev");
  const [mode, setMode] = useState<Mode>(() => savedMode);
  const [drafts, setDrafts] = useState(() => initialDrafts(settings, current, eligible, savedMode));
  const [other, setOther] = useState(() => {
    const first = savedMode;
    const draft = first === "jev" ? drafts.openrouter : drafts[first];
    const credential = eligible.find((item) => item.id === draft.credentialId);
    return {
      model: Boolean(draft.model) && !knownModel(first, draft.model, credential),
      vision: Boolean(draft.visionModel) && !knownModel(first, draft.visionModel, credential),
    };
  });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const busy = save.isPending || reset.isPending;
  const modeCredentials = eligible.filter((credential) => credential.provider === providerOf(mode));
  const modeDraft = mode === "jev" ? null : drafts[mode];
  const draftCredential = modeDraft
    ? eligible.find((credential) => credential.id === modeDraft.credentialId)
    : undefined;
  const draftGone = Boolean(modeDraft?.credentialId && !draftCredential);
  const derived = mode === "custom" ? (decisionEndpointOf(draftCredential) ?? "") : "";
  const effectiveEndpoint =
    mode === "custom" && modeDraft ? (decisionEndpointOf(draftCredential, modeDraft.endpoint) ?? "") : "";
  const inputValue = modeDraft
    ? decisionInputOf(
        {
          credentialId: modeDraft.credentialId,
          model: modeDraft.model,
          visionModel: modeDraft.visionModel,
          endpoint: modeDraft.endpoint,
        },
        mode,
      )
    : null;
  const ready = Boolean(inputValue && draftCredential);
  const input = [fieldText("callout"), styles.input, { color: c.ink }];
  const choices =
    mode === "openrouter"
      ? OPENROUTER_MODELS.map((model) => ({
          key: model.value,
          label: model.label,
          leading: { kind: "node" as const, node: <ProviderLogo id="openrouter" size="sm" /> },
        }))
      : modelChoices(draftCredential).map((model) => ({
          key: model.value,
          label: model.label,
          sub: model.sub,
          leading: { kind: "node" as const, node: <ProviderLogo id="custom" size="sm" /> },
        }));
  const visionChoices =
    mode === "openrouter"
      ? OPENROUTER_VISION.map((model) => ({
          key: model.value,
          label: model.label,
          leading: { kind: "node" as const, node: <ProviderLogo id="openrouter" size="sm" /> },
        }))
      : modelChoices(draftCredential).map((model) => ({
          key: model.value,
          label: model.label,
          sub: model.sub,
          leading: { kind: "node" as const, node: <ProviderLogo id="custom" size="sm" /> },
        }));
  const setDraft = (next: (draft: ProviderDraft) => ProviderDraft) => {
    if (mode === "jev") return;
    setSaved(false);
    setDrafts((all) => ({ ...all, [mode]: next(all[mode]) }));
  };
  const askCredential = async () => {
    if (mode === "jev" || busy) return;
    const picked = await pickOne({
      title: t("jev.decision.account"),
      options: modeCredentials.map((credential) => ({
        key: credential.id,
        label: credential.label,
        leading: { kind: "node" as const, node: <ProviderLogo id={credential.provider} size="sm" /> },
      })),
      value: modeDraft?.credentialId,
    });
    if (!picked) return;
    const credential = eligible.find((item) => item.id === picked);
    if (!credential) return;
    const next =
      credential.provider === "openrouter"
        ? { ...drafts.openrouter, credentialId: credential.id }
        : {
            ...drafts.custom,
            credentialId: credential.id,
            model: modelChoices(credential).some((model) => model.value === drafts.custom.model)
              ? drafts.custom.model
              : (modelChoices(credential)[0]?.value ?? ""),
            visionModel: modelChoices(credential).some((model) => model.value === drafts.custom.visionModel)
              ? drafts.custom.visionModel
              : (modelChoices(credential)[0]?.value ?? ""),
            endpoint: "",
          };
    setSaved(false);
    setDrafts((all) => ({ ...all, [mode]: next }));
    setOther({
      model: Boolean(next.model) && !knownModel(mode, next.model, credential),
      vision: Boolean(next.visionModel) && !knownModel(mode, next.visionModel, credential),
    });
  };
  const askModel = async (kind: "model" | "vision") => {
    if (!modeDraft) return;
    const options: PickOption[] = [
      ...(kind === "vision" ? [{ key: "", label: t("jev.decision.noVision") }] : []),
      ...(kind === "vision" ? visionChoices : choices),
      { key: OTHER_MODEL, label: t("jev.decision.otherModel") },
    ];
    const value = kind === "vision" ? modeDraft.visionModel : modeDraft.model;
    const picked = await pickOne({
      title: t(kind === "vision" ? "jev.decision.visionLabel" : "jev.decision.model"),
      options,
      value: other[kind] ? OTHER_MODEL : value,
    });
    if (picked === null) return;
    if (picked === OTHER_MODEL) {
      setOther((all) => ({ ...all, [kind]: true }));
      return;
    }
    setOther((all) => ({ ...all, [kind]: false }));
    setDraft((draft) => ({ ...draft, [kind === "vision" ? "visionModel" : "model"]: picked }));
  };
  const chooseMode = (next: Mode) => {
    if (next === mode || busy) return;
    setError(null);
    setSaved(false);
    if (next !== "jev") {
      const draft = drafts[next];
      const credential = eligible.find((item) => item.id === draft.credentialId);
      setOther({
        model: Boolean(draft.model) && !knownModel(next, draft.model, credential),
        vision: Boolean(draft.visionModel) && !knownModel(next, draft.visionModel, credential),
      });
      setMode(next);
      return;
    }
    if (!settings) {
      setMode("jev");
      return;
    }
    confirmAction({
      title: t("jev.decision.reset.title"),
      text: t("jev.decision.reset.text"),
      action: t("jev.decision.reset.confirm"),
      cancel: t("common.cancel"),
      onConfirm: () =>
        reset.mutate(undefined, {
          onSuccess: () => setMode("jev"),
          onError: (e) => setError(decisionErrorText(t, e)),
        }),
    });
  };
  const submit = () => {
    if (mode === "jev" || !inputValue || !ready) return;
    setError(null);
    setSaved(false);
    save.mutate(inputValue, {
      onSuccess: () => setSaved(true),
      onError: (e) => setError(decisionErrorText(t, e)),
    });
  };
  return (
    <View style={styles.section}>
      <Segmented
        wide
        value={mode}
        onChange={(next) => chooseMode(next as Mode)}
        items={[
          { key: "jev", label: t("jev.decision.jevTypeSafe") },
          { key: "openrouter", label: "OpenRouter" },
          { key: "custom", label: t("jev.decision.custom") },
        ]}
      />
      <Text variant="small" tone="muted">
        {t("jev.decision.about")}
      </Text>
      {mode === "jev" ? (
        <>
          <GroupedList>
            <GroupedRow
              leading={<ProviderLogo id="typesafe" size="sm" />}
              label={t("jev.decision.jevTypeSafe")}
              sub={t("jev.decision.jevMobile")}
              subLines={0}
            />
          </GroupedList>
          {settings ? (
            <Text variant="small" tone="muted">
              {t("jev.decision.reset.action")}
            </Text>
          ) : null}
        </>
      ) : (
        <>
          {settings ? (
            view.available ? (
              <Note icon="check" live>
                {t("jev.decision.active", {
                  account: current?.label ?? t("jev.decision.unknownAccount"),
                  model: settings.model,
                })}
              </Note>
            ) : (
              <Note icon="x" live>
                {t("jev.decision.unavailable")}
              </Note>
            )
          ) : null}
          {error ? (
            <Note icon="x" live>
              {error}
            </Note>
          ) : null}
          {saved ? (
            <Note icon="check" live>
              {t("jev.decision.saved")}
            </Note>
          ) : null}
          <GroupedList>
            <GroupedRow
              label={t("jev.decision.account")}
              value={
                draftCredential?.label ??
                (modeDraft?.credentialId
                  ? (credentials.find((credential) => credential.id === modeDraft.credentialId)?.label ??
                    t("jev.decision.unknownAccount"))
                  : t("jev.decision.chooseAccount"))
              }
              chevron
              disabled={busy}
              onPress={() => void askCredential()}
            />
          </GroupedList>
          {draftGone ? (
            <Note icon="x" live>
              {t("jev.decision.accountGone")}
            </Note>
          ) : null}
          {modeCredentials.length === 0 && !draftGone ? (
            <Note icon="info">
              {`${t(mode === "openrouter" ? "jev.decision.noOpenRouter" : "jev.decision.noCustom")} ${t("jev.decision.addInKeys")}`}
            </Note>
          ) : null}
          <GroupedList>
            <GroupedRow
              label={t("jev.decision.model")}
              sub={modeDraft?.model || t("jev.decision.modelPlaceholder")}
              subLines={0}
              chevron
              disabled={busy}
              onPress={() => void askModel("model")}
            />
            <GroupedRow
              label={t("jev.decision.visionLabel")}
              hint={{
                name: t("common.about", { label: t("jev.decision.visionLabel") }),
                text: t("jev.decision.visionHelp"),
              }}
              sub={modeDraft?.visionModel || t("jev.decision.noVision")}
              subLines={0}
              chevron
              disabled={busy}
              onPress={() => void askModel("vision")}
            />
          </GroupedList>
          {modeDraft && other.model ? (
            <GroupedList>
              <GroupedField label={t("jev.decision.modelId")}>
                <TextInput
                  value={modeDraft.model}
                  onChangeText={(model) => setDraft((draft) => ({ ...draft, model }))}
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                  editable={!busy}
                  maxLength={200}
                  placeholder={t("jev.decision.modelPlaceholder")}
                  placeholderTextColor={c.faint}
                  accessibilityLabel={t("jev.decision.modelId")}
                  style={input}
                />
              </GroupedField>
            </GroupedList>
          ) : null}
          {modeDraft && other.vision ? (
            <GroupedList>
              <GroupedField label={t("jev.decision.visionModelId")}>
                <TextInput
                  value={modeDraft.visionModel}
                  onChangeText={(visionModel) => setDraft((draft) => ({ ...draft, visionModel }))}
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                  editable={!busy}
                  maxLength={200}
                  placeholder={t("jev.decision.visionPlaceholder")}
                  placeholderTextColor={c.faint}
                  accessibilityLabel={t("jev.decision.visionModelId")}
                  style={input}
                />
              </GroupedField>
            </GroupedList>
          ) : null}
          {modeDraft && mode === "custom" && effectiveEndpoint ? (
            <>
              <GroupedHeader>{t("jev.decision.requestsTo")}</GroupedHeader>
              <Text variant="small" tone="muted" selectable style={styles.endpoint}>
                {effectiveEndpoint}
              </Text>
            </>
          ) : null}
          {modeDraft && mode === "custom" ? (
            <>
              <GroupedHeader>{t("jev.decision.advanced")}</GroupedHeader>
              <GroupedList>
                <GroupedField
                  label={t("jev.decision.fullEndpoint")}
                  hint={{
                    name: t("common.about", { label: t("jev.decision.fullEndpoint") }),
                    text: t("jev.decision.fullEndpointHelp"),
                  }}
                >
                  <TextInput
                    value={modeDraft.endpoint}
                    onChangeText={(endpoint) => setDraft((draft) => ({ ...draft, endpoint }))}
                    autoCapitalize="none"
                    autoCorrect={false}
                    spellCheck={false}
                    editable={!busy}
                    keyboardType="url"
                    placeholder={derived || "https://…"}
                    placeholderTextColor={c.faint}
                    accessibilityLabel={t("jev.decision.fullEndpoint")}
                    style={input}
                  />
                </GroupedField>
              </GroupedList>
            </>
          ) : null}
          {modeDraft?.model.trim() && !decisionModelIdValid(modeDraft.model) ? (
            <Text variant="small" tone="danger" accessibilityLiveRegion="polite">
              {t("jev.decision.modelInvalid")}
            </Text>
          ) : null}
          {modeDraft?.visionModel.trim() && !decisionModelIdValid(modeDraft.visionModel) ? (
            <Text variant="small" tone="danger" accessibilityLiveRegion="polite">
              {t("jev.decision.modelInvalid")}
            </Text>
          ) : null}
          <Note icon="info">{t("jev.decision.testNotice")}</Note>
          <Button
            variant="primary"
            wide
            label={save.isPending ? t("jev.decision.testing") : t("jev.decision.save")}
            loading={save.isPending}
            disabled={!ready || busy}
            onPress={submit}
          />
        </>
      )}
      {mode === "jev" && error ? (
        <Note icon="x" live>
          {error}
        </Note>
      ) : null}
      {mode === "jev" && saved ? (
        <Note icon="check" live>
          {t("jev.decision.saved")}
        </Note>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 12, marginTop: 20 },
  input: { flex: 1, paddingVertical: 12, paddingHorizontal: 0 },
  endpoint: { paddingHorizontal: 2 },
});
