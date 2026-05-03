/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Copyright (c) OpenLens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */
/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Copyright (c) OpenLens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

import { loggerInjectionToken } from "@freelensapp/logger";
import { cssNames, disposer } from "@freelensapp/utilities";
import { withInjectables } from "@ogre-tools/injectable-react";
import autoBindReact from "auto-bind/react";
import { debounce, merge } from "lodash";
import { action, computed, makeObservable, observable, reaction } from "mobx";
import { observer } from "mobx-react";
import { editor, Uri } from "monaco-editor";
import React from "react";
import userPreferencesStateInjectable from "../../../features/user-preferences/common/state.injectable";
import activeThemeInjectable from "../../themes/active.injectable";
import getEditorHeightFromLinesCountInjectable from "./get-editor-height-from-lines-number.injectable";
import styles from "./monaco-editor.module.scss";
import { type MonacoValidator, monacoValidators } from "./monaco-validators";

import type { Logger } from "@freelensapp/logger";

import type { IComputedValue } from "mobx";

import type { UserPreferencesState } from "../../../features/user-preferences/common/state.injectable";
import type { LensTheme } from "../../themes/lens-theme";
import type { MonacoTheme } from "./monaco-themes";

export type MonacoEditorId = string;

export interface MonacoEditorProps {
  id?: MonacoEditorId; // associating editor's ID with created model.uri
  className?: string;
  style?: React.CSSProperties;
  autoFocus?: boolean;
  readOnly?: boolean;
  theme?: MonacoTheme;
  language?: "yaml" | "json"; // supported list of languages, configure in `webpack.renderer.ts`
  options?: Partial<editor.IStandaloneEditorConstructionOptions>; // customize editor's initialization options
  value: string;
  onChange?(value: string, evt: editor.IModelContentChangedEvent): void; // catch latest value updates
  onError?(error: unknown): void; // provide syntax validation error, etc.
  onDidLayoutChange?(info: editor.EditorLayoutInfo): void;
  onDidContentSizeChange?(evt: editor.IContentSizeChangedEvent): void;
  onModelChange?(model: editor.ITextModel, prev?: editor.ITextModel): void;
  innerRef?: React.ForwardedRef<MonacoEditorRef>;
  setInitialHeight?: boolean;
}

interface Dependencies {
  state: UserPreferencesState;
  activeTheme: IComputedValue<LensTheme>;
  getEditorHeightFromLinesCount: (linesCount: number) => number;
  logger: Logger;
}

export function createMonacoUri(id: MonacoEditorId): Uri {
  return Uri.file(`/monaco-editor/${id}`);
}

const monacoViewStates = new WeakMap<Uri, editor.ICodeEditorViewState>();

export interface MonacoEditorRef {
  focus(): void;
}

@observer
class NonInjectedMonacoEditor extends React.Component<MonacoEditorProps & Dependencies> {
  static defaultProps = {
    language: "yaml" as const,
  };

  private staticId = `editor-id#${Math.round(1e7 * Math.random())}`;
  private dispose = disposer();

  @observable.ref containerElem: HTMLDivElement | null = null;
  @observable.ref editor!: editor.IStandaloneCodeEditor;
  @observable readonly dimensions: { width?: number; height?: number } = {};
  @observable unmounting = false;

  // TODO: investigate how to replace with "common/logger"
  //  currently leads for stucking UI forever & infinite loop.
  //  e.g. happens on tab change/create, maybe some other cases too.
  private logger = console;

  constructor(props: MonacoEditorProps & Dependencies) {
    super(props);
    makeObservable(this);
    autoBindReact(this);
  }

  @computed get id(): MonacoEditorId {
    return this.props.id ?? this.staticId;
  }

  @computed get theme() {
    return this.props.theme ?? this.props.activeTheme.get().monacoTheme;
  }

  @computed get model(): editor.ITextModel {
    const uri = createMonacoUri(this.id);
    const model = editor.getModel(uri);

    if (model) {
      return model; // already exists
    }

    const { language, value: rawValue } = this.props;
    const value = typeof rawValue === "string" ? rawValue : "";

    if (typeof rawValue !== "string") {
      this.props.logger.error(`[MONACO-EDITOR]: Passed a non-string default value`, { rawValue });
    }

    return editor.createModel(value, language, uri);
  }

  @computed get options(): editor.IStandaloneEditorConstructionOptions {
    return merge({}, this.props.state.editorConfiguration, this.props.options);
  }

  @computed
  private get logMetadata() {
    return {
      editorId: this.id,
      model: this.model,
    };
  }

  /**
   * Monitor editor's dom container element box-size and sync with monaco's dimensions
   * @private
   */
  private bindResizeObserver() {
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;

        this.setDimensions(width, height);
      }
    });

    const containerElem = this.editor.getContainerDomNode();

    resizeObserver.observe(containerElem);

    return () => resizeObserver.unobserve(containerElem);
  }

  protected onModelChange(model: editor.ITextModel, oldModel?: editor.ITextModel) {
    this.logger.info("[MONACO]: model change", { model, oldModel }, this.logMetadata);

    if (oldModel) {
      this.saveViewState(oldModel);
    }

    this.editor.setModel(model);
    this.restoreViewState(model);
    this.editor.layout();
    this.editor.focus(); // keep focus in editor, e.g. when clicking between dock-tabs
    this.props.onModelChange?.(model, oldModel);
    this.validateLazy();
  }

  /**
   * Save current view-model state in the editor.
   * This will allow restore cursor position, selected text, etc.
   */
  protected saveViewState(model: editor.ITextModel) {
    const viewState = this.editor?.saveViewState();

    if (viewState) {
      monacoViewStates.set(model.uri, viewState);
    }
  }

  protected restoreViewState(model: editor.ITextModel) {
    const viewState = monacoViewStates.get(model.uri);

    if (viewState) {
      this.editor?.restoreViewState(viewState);
    }
  }

  componentDidMount() {
    try {
      this.createEditor();
      this.logger.info(`[MONACO]: editor did mount`, this.logMetadata);
    } catch (error) {
      this.logger.error(`[MONACO]: mounting failed: ${error}`, this.logMetadata);
    }
  }

  componentWillUnmount() {
    this.unmounting = true;
    this.saveViewState(this.model);

    if (this.editor) {
      this.dispose();
      this.editor.dispose();
    }
  }

  protected createEditor() {
    if (!this.containerElem || this.editor || this.unmounting) {
      return;
    }
    const { language, readOnly, value: defaultValue } = this.props;
    const { theme } = this;

    this.editor = editor.create(this.containerElem, {
      model: this.model,
      detectIndentation: false, // allow `option.tabSize` to use custom number of spaces for [Tab]
      value: defaultValue,
      language,
      theme,
      readOnly,
      ...this.options,
    });

    // Internal-fork hardening (upstream issue #721):
    //
    // Cmd+V / Ctrl+V doesn't paste into Monaco's Find Widget search
    // input. The Find Widget's input lives inside the editor's DOM and
    // Monaco's keybinding service intercepts the V keystroke at the
    // editor level, but the editor's clipboardPasteAction targets the
    // editor model -- not the find input -- so the keystroke is
    // effectively swallowed. Electron's default Edit-menu role:'paste'
    // also doesn't fire because the editor's keydown handler stops the
    // event before it reaches the Electron-roles layer.
    //
    // Capture-phase keydown listener on the editor container: when the
    // user is typing inside one of the widget inputs (find, replace,
    // and the various .monaco-inputbox descendants) and presses Cmd+V
    // / Ctrl+V, read clipboard text and insert it at the input's
    // selection. We DON'T touch the keystroke when focus is in the
    // editor body itself -- Monaco's normal paste path is fine there.
    const containerNode = this.editor.getContainerDomNode();
    const onWidgetPaste = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (!meta || (event.key !== "v" && event.key !== "V")) return;

      const target = event.target as HTMLElement | null;
      if (!target) return;

      // Only intervene for input/textarea descendants of monaco's
      // widget panels (find, replace, suggest, command palette).
      const widgetHost = target.closest(
        ".find-widget, .editor-widget, .monaco-inputbox, .quick-input-widget",
      );
      if (!widgetHost) return;
      if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) return;

      event.preventDefault();
      event.stopPropagation();

      void navigator.clipboard.readText().then((text) => {
        if (!text) return;
        const input = target;
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? input.value.length;
        const before = input.value.slice(0, start);
        const after = input.value.slice(end);
        input.value = `${before}${text}${after}`;
        const caret = start + text.length;
        input.setSelectionRange(caret, caret);
        // Notify React / Monaco listeners.
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }).catch((err) => {
        this.logger.warn("[MONACO]: widget paste failed", err);
      });
    };
    containerNode.addEventListener("keydown", onWidgetPaste, /* useCapture */ true);

    this.logger.info(`[MONACO]: editor created for language=${language}, theme=${theme}`, this.logMetadata);
    this.validateLazy(); // validate initial value
    this.restoreViewState(this.model); // restore previous state if any

    if (this.props.autoFocus) {
      this.editor.focus();
    }

    const onDidLayoutChangeDisposer = this.editor.onDidLayoutChange((layoutInfo) => {
      this.props.onDidLayoutChange?.(layoutInfo);
    });

    const onValueChangeDisposer = this.editor.onDidChangeModelContent((event) => {
      const value = this.editor.getValue();

      this.props.onChange?.(value, event);
      this.validateLazy(value);
    });

    const onContentSizeChangeDisposer = this.editor.onDidContentSizeChange((params) => {
      this.props.onDidContentSizeChange?.(params);
    });

    this.dispose.push(
      reaction(() => this.model, this.onModelChange),
      reaction(() => this.theme, editor.setTheme),
      reaction(
        () => this.props.value,
        (value) => this.setValue(value),
        {
          fireImmediately: true,
        },
      ),
      reaction(
        () => this.options,
        (opts) => this.editor.updateOptions(opts),
      ),

      () => onDidLayoutChangeDisposer.dispose(),
      () => onValueChangeDisposer.dispose(),
      () => onContentSizeChangeDisposer.dispose(),
      () => containerNode.removeEventListener("keydown", onWidgetPaste, /* useCapture */ true),
      this.bindResizeObserver(),
    );
  }

  @action
  setDimensions(width: number, height: number) {
    this.dimensions.width = width;
    this.dimensions.height = height;
    this.editor?.layout({ width, height });
  }

  setValue(value = ""): void {
    if (value == this.getValue()) return;

    this.editor.setValue(value);
    this.validate(value);
  }

  getValue(opts?: { preserveBOM: boolean; lineEnding: string }): string {
    return this.editor?.getValue(opts) ?? "";
  }

  focus() {
    this.editor?.focus();
  }

  @action
  validate(value = this.getValue()) {
    const validators: MonacoValidator[] = [
      monacoValidators[this.props.language!], // parsing syntax check
    ].filter(Boolean);

    for (const validate of validators) {
      try {
        validate(value);
      } catch (error) {
        this.props.onError?.(error); // emit error outside
      }
    }
  }

  // avoid excessive validations during typing
  validateLazy = debounce(this.validate, 250);

  get initialHeight() {
    return this.props.getEditorHeightFromLinesCount(this.model.getLineCount());
  }

  render() {
    const { className, style } = this.props;

    const css: React.CSSProperties = {
      ...style,
      height: style?.height ?? this.initialHeight,
    };

    return (
      <div
        data-test-id="monaco-editor"
        className={cssNames(styles.MonacoEditor, className)}
        style={css}
        ref={(elem) => (this.containerElem = elem)}
      />
    );
  }
}

const ForwardedRefMonacoEditor = React.forwardRef<MonacoEditorRef, MonacoEditorProps & Dependencies>((props, ref) => (
  <NonInjectedMonacoEditor innerRef={ref} {...props} />
));

export const MonacoEditor = withInjectables<Dependencies, MonacoEditorProps, MonacoEditorRef>(
  ForwardedRefMonacoEditor,
  {
    getProps: (di, props) => ({
      ...props,
      state: di.inject(userPreferencesStateInjectable),
      activeTheme: di.inject(activeThemeInjectable),
      getEditorHeightFromLinesCount: di.inject(getEditorHeightFromLinesCountInjectable),
      logger: di.inject(loggerInjectionToken),
    }),
  },
);
