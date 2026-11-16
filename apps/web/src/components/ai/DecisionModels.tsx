import type { AiRouting, Credential, DecisionSettings, DecisionSettingsView, JevKey } from "@agenteschat/client";
import {
  useCredentials,
  useDecisionSettings,
  useJevKey,
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
import {
  Button,
  Field,
  FormActions,
  InfoHint,
  Input,
  Locked,
  ProviderLogo,
  Segmented,
  Select,
  type SelectOption,
  SettingNote,
} from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ModelSelect } from "@/components/AgentFields";
import { useOrg } from "@/components/org-context";
import { JevSettings } from "./Jev";

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
const OPENROUTER_DEFAULT = OPENROUTER_MODELS[0]?.value ?? "typesafe/jev-1.14";
const OPENROUTER_VISION_DEFAULT = OPENROUTER_VISION[0]?.value ?? "typesafe/jev-1.14";

/** An endpoint override belongs to Custom only, so this refusal says that instead of the generic address line. */
const decisionErrorText = (t: TFunction, error: unknown): string =>
  errorCode(error) === "decision_endpoint_unsupported" ? t("jev.decision.error.endpoint") : errorText(t, error);

const providerOf = (mode: Mode): ProviderMode | null => (mode === "jev" ? null : mode);

const modelsOf = (credential: Credential | undefined): readonly SelectOption[] =>
  (credential?.endpoint?.models ?? []).map((model) => ({
    value: model.id,
    label: model.label ?? model.id,
    description: model.label ? model.id : undefined,
  }));

const initialDrafts = (
  settings: DecisionSettings | null,
  current: Credential | undefined,
  eligible: readonly Credential[],
  savedMode: Mode,
): Record<ProviderMode, ProviderDraft> => {
  const openRouter = eligible.find((credential) => credential.provider === "openrouter");
  const custom = eligible.find((credential) => credential.provider === "custom");
  const customModels = modelsOf(custom);
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

/**
 * A workspace's decision models (ADR 0195): one card and one provider choice. Jev keeps the installation's key
 * setup. OpenRouter and custom endpoints reuse live credentials from Provider keys, so a key is never entered twice.
 * The probe stays the compatibility test; choosing a chat model here does not bypass it.
 */
export function DecisionModels({ routing }: { routing?: AiRouting["by"] }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const allowed = can(org, "manage_credentials");
  const view = useDecisionSettings(org.id, allowed);
  const credentials = useCredentials(org.id, allowed);
  const jev = useJevKey();
  if (!allowed) return null;
  if (!view.isSuccess || !credentials.isSuccess || jev.isPending) {
    return <p className="small muted">{t("common.loading")}</p>;
  }
  return (
    <DecisionForm
      view={view.data}
      credentials={credentials.data}
      jev={jev.data ?? null}
      routing={routing}
      orgId={org.id}
    />
  );
}

function DecisionForm({
  view,
  credentials,
  jev,
  routing,
  orgId,
}: {
  view: DecisionSettingsView;
  credentials: readonly Credential[];
  jev: JevKey | null;
  routing?: AiRouting["by"];
  orgId: string;
}) {
  const { t } = useTranslation();
  const save = useSaveDecisionSettings(orgId);
  const reset = useResetDecisionSettings(orgId);
  const settings = view.settings;
  const current = credentialRowOf(credentials, settings?.credentialId);
  const eligible = decisionCredentials(credentials);
  const savedMode = decisionModeOf(settings, credentials) ?? (settings ? "custom" : "jev");
  const [mode, setMode] = useState<Mode>(() => savedMode);
  const [drafts, setDrafts] = useState(() => initialDrafts(settings, current, eligible, savedMode));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const ids = useId();
  const busy = save.isPending || reset.isPending;
  const modeCredentials = eligible.filter((credential) => credential.provider === providerOf(mode));
  const modeDraft = mode === "jev" ? null : drafts[mode];
  const draftCredential = modeDraft
    ? eligible.find((credential) => credential.id === modeDraft.credentialId)
    : undefined;
  const draftGone = Boolean(modeDraft?.credentialId && !draftCredential);
  const activeCredential = current ?? draftCredential;
  const derived = mode === "custom" ? (decisionEndpointOf(draftCredential) ?? "") : "";
  const effectiveEndpoint =
    mode === "custom" && modeDraft ? (decisionEndpointOf(draftCredential, modeDraft.endpoint) ?? "") : "";
  const input = modeDraft
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
  const ready = Boolean(input && draftCredential);
  const setDraft = (next: (draft: ProviderDraft) => ProviderDraft) => {
    if (mode === "jev") return;
    setSaved(false);
    setDrafts((all) => ({ ...all, [mode]: next(all[mode]) }));
  };
  const chooseCredential = (credential: Credential | undefined) => {
    if (!credential) return;
    setDraft((draft) => {
      if (credential.provider === "openrouter") {
        return { ...draft, credentialId: credential.id };
      }
      const models = modelsOf(credential);
      return {
        ...draft,
        credentialId: credential.id,
        model: models.some((model) => model.value === draft.model) ? draft.model : (models[0]?.value ?? ""),
        visionModel: models.some((model) => model.value === draft.visionModel)
          ? draft.visionModel
          : (models[0]?.value ?? ""),
        endpoint: "",
      };
    });
  };
  const chooseMode = (next: Mode) => {
    if (next === mode || busy) return;
    setError(null);
    setSaved(false);
    if (next !== "jev") {
      setMode(next);
      return;
    }
    if (!settings) {
      setMode("jev");
      return;
    }
    reset.mutate(undefined, {
      onSuccess: () => setMode("jev"),
      onError: (e) => setError(decisionErrorText(t, e)),
    });
  };
  const submit = () => {
    if (mode === "jev" || !input || !ready) return;
    setError(null);
    setSaved(false);
    save.mutate(input, {
      onSuccess: () => setSaved(true),
      onError: (e) => setError(decisionErrorText(t, e)),
    });
  };
  const savedLabel = current?.label ?? t("jev.decision.unknownAccount");
  const availability = settings ? (
    view.available ? (
      <SettingNote icon="check" live>
        {t("jev.decision.active", {
          account: savedLabel,
          model: settings.model,
        })}
      </SettingNote>
    ) : (
      <SettingNote icon="alert" live>
        {t("jev.decision.unavailable")}
      </SettingNote>
    )
  ) : null;

  return (
    <div className="jev-decision">
      <Field label={t("jev.decision.provider")} group>
        <Segmented<Mode>
          label={t("jev.decision.provider")}
          value={mode}
          disabled={busy}
          onValueChange={chooseMode}
          options={[
            { value: "jev", label: t("jev.decision.jevTypeSafe") },
            { value: "openrouter", label: "OpenRouter" },
            { value: "custom", label: t("jev.decision.custom") },
          ]}
        />
      </Field>
      <p className="who-line">{t("jev.decision.about")}</p>
      {mode === "jev" ? (
        jev ? (
          <JevSettings routing={routing} embedded />
        ) : (
          <SettingNote icon="info">{t("jev.decision.jevManaged")}</SettingNote>
        )
      ) : (
        <>
          {availability}
          {saved && (
            <SettingNote icon="check" live>
              {t("jev.decision.saved")}
            </SettingNote>
          )}
          {error && (
            <SettingNote icon="alert" live>
              {error}
            </SettingNote>
          )}
          {mode === "custom" && <CustomEndpointNotice endpoint={effectiveEndpoint} />}
          {modeCredentials.length === 0 && !draftGone ? (
            <SettingNote icon="info">
              {t(mode === "openrouter" ? "jev.decision.noOpenRouter" : "jev.decision.noCustom")}{" "}
              <a className="ac-link" href="#sec-keys">
                {t("settings.keysTitle")}
              </a>
              .
            </SettingNote>
          ) : null}
          <Locked when={busy}>
            <div className="jev-decision__fields">
              <Field label={t("jev.decision.account")} id={`${ids}-account`}>
                <Select
                  value={modeDraft?.credentialId}
                  onValueChange={(id) => chooseCredential(eligible.find((credential) => credential.id === id))}
                  options={credentialOptions(credentials, modeCredentials, modeDraft?.credentialId, t)}
                  placeholder={t("jev.decision.chooseAccount")}
                  aria-label={t("jev.decision.account")}
                  disabled={busy}
                />
              </Field>
              {draftGone && (
                <SettingNote icon="alert" live>
                  {t("jev.decision.accountGone")}
                </SettingNote>
              )}
              {modeDraft && (
                <>
                  <DecisionModelField
                    key={`${mode}-text-${modeDraft.credentialId}`}
                    label={t("jev.decision.model")}
                    idLabel={t("jev.decision.modelId")}
                    value={modeDraft.model}
                    onChange={(model) => setDraft((draft) => ({ ...draft, model }))}
                    models={
                      mode === "openrouter"
                        ? OPENROUTER_MODELS.map((model) => ({
                            ...model,
                            leading: <ProviderLogo id="openrouter" size="sm" />,
                          }))
                        : modelsOf(draftCredential).map((model) => ({
                            ...model,
                            leading: <ProviderLogo id="custom" size="sm" />,
                          }))
                    }
                    otherLabel={t("jev.decision.otherModel")}
                    placeholder={t("jev.decision.modelPlaceholder")}
                    disabled={busy}
                  />
                  <DecisionModelField
                    key={`${mode}-vision-${modeDraft.credentialId}`}
                    label={t("jev.decision.visionLabel")}
                    idLabel={t("jev.decision.visionModelId")}
                    hint={t("jev.decision.visionHelp")}
                    value={modeDraft.visionModel}
                    onChange={(visionModel) => setDraft((draft) => ({ ...draft, visionModel }))}
                    models={
                      mode === "openrouter"
                        ? OPENROUTER_VISION.map((model) => ({
                            ...model,
                            leading: <ProviderLogo id="openrouter" size="sm" />,
                          }))
                        : modelsOf(draftCredential).map((model) => ({
                            ...model,
                            leading: <ProviderLogo id="custom" size="sm" />,
                          }))
                    }
                    offLabel={t("jev.decision.noVision")}
                    otherLabel={t("jev.decision.otherModel")}
                    placeholder={t("jev.decision.visionPlaceholder")}
                    disabled={busy}
                  />
                  {mode === "custom" && (
                    <details className="cflow__more">
                      <summary>{t("jev.decision.advanced")}</summary>
                      <Field
                        label={t("jev.decision.fullEndpoint")}
                        id={`${ids}-endpoint`}
                        hint={{
                          name: t("common.about", { label: t("jev.decision.fullEndpoint") }),
                          text: t("jev.decision.fullEndpointHelp"),
                        }}
                        example={
                          derived
                            ? t("jev.decision.endpointExample", { endpoint: derived })
                            : t("jev.decision.endpointExampleEmpty")
                        }
                      >
                        <Input
                          id={`${ids}-endpoint`}
                          value={modeDraft.endpoint}
                          autoComplete="off"
                          spellCheck={false}
                          placeholder={derived || "https://…"}
                          onChange={(e) => setDraft((draft) => ({ ...draft, endpoint: e.target.value }))}
                        />
                      </Field>
                    </details>
                  )}
                </>
              )}
            </div>
          </Locked>
          <SettingNote icon="info">{t("jev.decision.testNotice")}</SettingNote>
          <FormActions note={save.isPending ? t("jev.decision.testing") : undefined}>
            <Button variant="primary" loading={save.isPending} disabled={!ready || busy} onClick={submit}>
              {t("jev.decision.save")}
            </Button>
          </FormActions>
        </>
      )}
      {mode === "jev" && error && (
        <SettingNote icon="alert" live>
          {error}
        </SettingNote>
      )}
      {mode === "jev" && saved && (
        <SettingNote icon="check" live>
          {t("jev.decision.saved")}
        </SettingNote>
      )}
      {mode !== "jev" && activeCredential && settings && (
        <p className="jev-decision__facts small muted">
          <span className="jev__fact jev__id">{settings.model}</span>
          {" · "}
          <span className="jev__fact jev__id">
            {settings.visionModel
              ? t("jev.decision.vision", { model: settings.visionModel })
              : t("jev.decision.noVision")}
          </span>
        </p>
      )}
    </div>
  );
}

const credentialOptions = (
  all: readonly Credential[],
  live: readonly Credential[],
  selected: string | undefined,
  t: TFunction,
): SelectOption[] => {
  const options: SelectOption[] = live.map((credential) => ({
    value: credential.id,
    label: credential.label,
    leading: <ProviderLogo id={credential.provider} size="sm" />,
  }));
  if (selected && !live.some((credential) => credential.id === selected)) {
    const known = all.find((credential) => credential.id === selected);
    options.unshift({
      value: selected,
      label: known?.label ?? t("jev.decision.unknownAccount"),
      description: t("jev.decision.unavailableOption"),
      leading: <ProviderLogo id={known?.provider ?? "custom"} size="sm" off />,
    });
  }
  return options;
};

function DecisionModelField({
  label,
  idLabel,
  hint,
  value,
  onChange,
  models,
  offLabel,
  otherLabel,
  placeholder,
  disabled,
}: {
  label: string;
  idLabel: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  models: readonly SelectOption[];
  offLabel?: string;
  otherLabel: string;
  placeholder: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const choices = [...(offLabel !== undefined ? [{ value: "", label: offLabel }] : []), ...models];
  const [other, setOther] = useState(() => value !== "" && !choices.some((choice) => choice.value === value));
  const invalid = value.trim() !== "" && !decisionModelIdValid(value);
  return (
    <Field
      label={label}
      id={`${id}-select`}
      hint={hint ? { name: t("common.about", { label }), text: hint } : undefined}
      error={invalid ? t("jev.decision.modelInvalid") : undefined}
    >
      <ModelSelect
        aria-label={label}
        value={other ? OTHER_MODEL : value}
        onChange={(next) => {
          if (next === OTHER_MODEL) {
            setOther(true);
            return;
          }
          setOther(false);
          onChange(next);
        }}
        disabled={disabled}
        options={[
          ...choices.map((choice) => ({
            ...choice,
            ...(choice.value ? { description: choice.description ?? choice.value } : {}),
          })),
          { value: OTHER_MODEL, label: otherLabel, action: true },
        ]}
      />
      {other && (
        <Input
          aria-label={idLabel}
          value={value}
          maxLength={200}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          invalid={invalid}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

function CustomEndpointNotice({ endpoint }: { endpoint: string }) {
  const { t } = useTranslation();
  if (!endpoint) return null;
  return (
    <div className="jev-decision__endpoint">
      <span className="ac-hintline">
        <span className="small muted">{t("jev.decision.requestsTo")}</span>
        <InfoHint name={t("common.about", { label: t("jev.decision.requestsTo") })}>
          {t("jev.decision.derivedEndpoint")}
        </InfoHint>
      </span>
      <code className="ac-inlinecode jev__id">{endpoint}</code>
    </div>
  );
}
