// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation.  All rights reserved.
// ----------------------------------------------------------------------------

import * as assert from 'assert';
import * as fse from 'fs-extra';
import * as path from 'path';
import { commands, MessageItem, TextDocument, Uri, window, workspace } from 'vscode';
import { callWithTelemetryAndErrorHandling, DialogResponses, IActionContext, IAzureQuickPickItem, UserCancelledError } from 'vscode-azureextensionui';
import { armTemplateLanguageId, configKeys } from '../../constants';
import { ext } from '../../extensionVariables';
import { containsParametersSchema } from '../../schemas';
import { normalizePath } from '../../util/normalizePath';
import { pathExists } from '../../util/pathExists';
import { DeploymentTemplateDoc } from '../templates/DeploymentTemplateDoc';
import { documentSchemes } from '../templates/supported';
import { DeploymentFileMapping } from './DeploymentFileMapping';
import { queryCreateParameterFile } from './parameterFileGeneration';
import { getRelativeParameterFilePath } from './parameterFilePaths';

const readAtMostBytesToFindParamsSchema = 4 * 1024;
const currentMessage = "Current";
const similarFilenameMessage = "Similar filename";
const fileNotFoundMessage = "File not found";
const howToMessage = `You can manually select the parameter file for this template at any time by clicking "Select/Create Parameter File..." in the status bar or the editor context menu.`;

// Not worrying about Win32 case-insensitivity here because
// it's this vscode instance and local only and thus likely to be the
// same casing whenever it's loaded. Also, consequences of being wrong
// are minor.
const _filesToIgnoreThisSession: Set<string> = new Set<string>();

interface IPossibleParameterFile {
  uri: Uri;
  friendlyPath: string;
  isCloseNameMatch: boolean;
  fileNotFound?: boolean;
}

// tslint:disable-next-line: max-func-body-length
export async function selectParameterFile(actionContext: IActionContext, mapping: DeploymentFileMapping, sourceUri: Uri | undefined): Promise<void> {
  const editor = window.activeTextEditor;
  if (!sourceUri) {
    sourceUri = window.activeTextEditor?.document.uri;
  }

  if (!editor || !sourceUri || editor.document.uri.fsPath !== sourceUri.fsPath) {
    await ext.ui.showWarningMessage(`Please open an Azure Resource Manager template file before trying to associate or create a parameter file.`);
    return;

  }
  if (editor.document.languageId !== armTemplateLanguageId) {
    actionContext.telemetry.properties.languageId = editor.document.languageId;
    await ext.ui.showWarningMessage(`The current file "${sourceUri.fsPath}" does not appear to be an Azure Resource Manager Template. Please open one or make sure the editor Language Mode in the context menu is set to "Azure Resource Manager Template".`);
    return;
  }

  let templateUri: Uri = sourceUri;

  if (templateUri.scheme === documentSchemes.untitled) {
    actionContext.errorHandling.suppressReportIssue = true;
    throw new Error("Please save the template file before associating it with a parameter file.");
  }

  // Get the template file contents so we can find the top-level parameters
  const contents = editor.document.getText(undefined);
  const template: DeploymentTemplateDoc = new DeploymentTemplateDoc(contents, templateUri);

  let quickPickList: IQuickPickList = await createParameterFileQuickPickList(mapping, templateUri);
  // Show the quick pick
  const result: IAzureQuickPickItem<IPossibleParameterFile | undefined> = await ext.ui.showQuickPick(
    quickPickList.items,
    {
      canPickMany: false,
      placeHolder: `Select a parameter file for "${path.basename(templateUri.fsPath)}"`,
      suppressPersistence: true
    });

  // Interpret result
  if (result === quickPickList.none) {
    // None

    // Remove the mapping for this file
    await dontAskAboutThisFile(templateUri, actionContext);
    await mapping.mapParameterFile(templateUri, undefined, { saveInSettings: true });
  } else if (result === quickPickList.browse) {
    // Browse...

    const paramsPaths: Uri[] | undefined = await window.showOpenDialog({
      canSelectMany: false,
      defaultUri: templateUri,
      openLabel: "Select Parameter File"
    });
    if (!paramsPaths || paramsPaths.length !== 1) {
      throw new UserCancelledError();
    }
    const selectedParamsPath: Uri = paramsPaths[0];

    if (!await isParameterFile(selectedParamsPath.fsPath)) {
      const selectAnywayResult = await ext.ui.showWarningMessage(
        `"${selectedParamsPath.fsPath}" does not appear to be a valid parameter file. Select it anyway?`,
        { modal: true },
        DialogResponses.yes,
        DialogResponses.no
      );
      if (selectAnywayResult !== DialogResponses.yes) {
        throw new UserCancelledError();
      }
    }

    await dontAskAboutThisFile(templateUri, actionContext);

    // Map to the browsed file
    await mapping.mapParameterFile(templateUri, selectedParamsPath, { saveInSettings: true });
  } else if (result === quickPickList.newFile) {
    // New parameter file

    let newUri: Uri = await queryCreateParameterFile(actionContext, template.topLevelScope);
    await mapping.mapParameterFile(templateUri, newUri, { saveInSettings: true });
    await commands.executeCommand('azurerm-vscode-tools.openParameterFile', templateUri, newUri);
  } else if (result === quickPickList.openCurrent) {
    // Open current

    await commands.executeCommand('azurerm-vscode-tools.openParameterFile', templateUri);
  } else if (result.data === quickPickList.currentParamFile) {
    // Current re-selected

    // Nothing to change
    dontAskAgainThisSession(templateUri, actionContext);
  } else {
    // Item in the list selected

    assert(result.data, "Quick pick item should have had data");
    await dontAskAboutThisFile(templateUri, actionContext);
    await mapping.mapParameterFile(templateUri, result.data?.uri, { saveInSettings: true });
  }
}

export async function openParameterFile(mapping: DeploymentFileMapping, templateUri: Uri | undefined, parameterUri: Uri | undefined): Promise<void> {
  if (templateUri) {
    let paramFile: Uri | undefined = parameterUri || mapping.getParameterFile(templateUri);
    if (!paramFile) {
      throw new Error(`There is currently no parameter file for template file "${templateUri.fsPath}"`);
    }

    let doc: TextDocument = await workspace.openTextDocument(paramFile);
    await window.showTextDocument(doc);
  }
}

export async function openTemplateFile(mapping: DeploymentFileMapping, parameterUri: Uri | undefined, templateUri: Uri | undefined): Promise<void> {
  if (parameterUri) {
    let templateFile: Uri | undefined = templateUri || mapping.getTemplateFile(parameterUri);
    if (!templateFile) {
      throw new Error(`There is no template file currently associated with parameter file "${parameterUri.fsPath}"`);
    }

    let doc: TextDocument = await workspace.openTextDocument(templateFile);
    await window.showTextDocument(doc);
  }
}

/**
 * If the file is inside the workspace folder, use the path relative to that, otherwise
 * use the absolute path.  This is intended for UI only.
 */
export function getFriendlyPathToFile(uri: Uri): string {
  const workspaceFolder = workspace.getWorkspaceFolder(uri);

  if (workspaceFolder) {
    return path.relative(workspaceFolder.uri.fsPath, uri.fsPath);
  } else {
    return uri.fsPath;
  }
}

interface IQuickPickList {
  items: IAzureQuickPickItem<IPossibleParameterFile | undefined>[];
  currentParamFile: IPossibleParameterFile | undefined;
  none: IAzureQuickPickItem<IPossibleParameterFile | undefined>;
  newFile: IAzureQuickPickItem<IPossibleParameterFile | undefined>;
  browse: IAzureQuickPickItem<IPossibleParameterFile | undefined>;
  openCurrent: IAzureQuickPickItem<IPossibleParameterFile | undefined>;
}

async function createParameterFileQuickPickList(mapping: DeploymentFileMapping, templateUri: Uri): Promise<IQuickPickList> {
  // Find likely parameter file matches
  let suggestions: IPossibleParameterFile[] = await findSuggestedParameterFiles(templateUri);

  // Find the current in that list
  const currentParamUri: Uri | undefined = mapping.getParameterFile(templateUri);
  const currentParamPathNormalized: string | undefined = currentParamUri ? normalizePath(currentParamUri) : undefined;
  let currentParamFile: IPossibleParameterFile | undefined = suggestions.find(pf => normalizePath(pf.uri) === currentParamPathNormalized);
  if (currentParamUri && !currentParamFile) {
    // There is a current parameter file, but it wasn't among the list we came up with.  We must add it to the list.
    currentParamFile = { isCloseNameMatch: false, uri: currentParamUri, friendlyPath: getRelativeParameterFilePath(templateUri, currentParamUri) };
    let exists = await pathExists(currentParamUri);
    currentParamFile.fileNotFound = !exists;

    suggestions = suggestions.concat(currentParamFile);
  }

  // Create initial pick list and sort it
  let pickItems: IAzureQuickPickItem<IPossibleParameterFile | undefined>[] = suggestions.map(paramFile => createQuickPickItem(paramFile, currentParamFile, templateUri));
  sortQuickPickList(pickItems);

  // Move the current item (if any) to the top
  const currentItem = pickItems.find(pi => pi.data === currentParamFile);
  if (currentItem) {
    // tslint:disable-next-line: no-any
    pickItems = [currentItem].concat(pickItems.filter(ppf => ppf !== currentItem));
  }

  // Add None at top, New/Browse/Open Current at bottom
  const none: IAzureQuickPickItem<IPossibleParameterFile | undefined> = {
    label: "$(circle-slash) None",
    description: !!currentParamUri ? undefined : currentMessage,
    data: undefined
  };
  const browse: IAzureQuickPickItem<IPossibleParameterFile | undefined> = {
    label: '$(file-directory) Browse...',
    data: undefined
  };
  const openCurrent: IAzureQuickPickItem<IPossibleParameterFile | undefined> = {
    label: '$(go-to-file) Open Current',
    data: undefined
  };
  const newFile: IAzureQuickPickItem<IPossibleParameterFile | undefined> = {
    label: '$(new-file) New...',
    data: undefined
  };
  pickItems = [none].concat(pickItems).concat([newFile, browse]);

  if (currentItem) {
    pickItems = pickItems.concat([openCurrent]);
  }

  return {
    items: pickItems,
    currentParamFile,
    none,
    browse,
    openCurrent,
    newFile
  };
}

function sortQuickPickList(pickItems: IAzureQuickPickItem<IPossibleParameterFile | undefined>[]): void {
  pickItems.sort((a, b) => {
    const aData = a?.data;
    const bData = a?.data;

    // Close name matches go first
    if (a?.data?.isCloseNameMatch !== b?.data?.isCloseNameMatch) {
      return a?.data?.isCloseNameMatch ? -1 : 1;
    }

    // Otherwise compare filenames
    // tslint:disable-next-line: strict-boolean-expressions
    return (aData?.uri.fsPath || "").localeCompare(bData?.uri.fsPath || "");
  });
}

function createQuickPickItem(paramFile: IPossibleParameterFile, current: IPossibleParameterFile | undefined, templateUri: Uri): IAzureQuickPickItem<IPossibleParameterFile> {
  const isCurrent: boolean = paramFile === current;
  let description = isCurrent ? currentMessage
    : paramFile.isCloseNameMatch ? similarFilenameMessage
      : undefined;
  if (paramFile.fileNotFound) {
    description += ` $(error) ${fileNotFoundMessage}`;
  }
  return {
    label: `${isCurrent ? '$(check) ' : '$(json) '} ${paramFile.friendlyPath}`,
    data: paramFile,
    description
  };
}

/**
 * Finds parameter files to suggest for a given template.
 */
export async function findSuggestedParameterFiles(templateUri: Uri): Promise<IPossibleParameterFile[]> {
  let paths: IPossibleParameterFile[] = [];

  return await callWithTelemetryAndErrorHandling('findSuggestedParameterFiles', async (actionContext: IActionContext) => {
    actionContext.errorHandling.rethrow = false;

    // Current logic is simple: Find all .json/c files in the same folder as the template file and check
    //   if they're a parameter file
    try {
      const folder = path.dirname(templateUri.fsPath);
      const fileNames: string[] = await fse.readdir(folder);
      for (let paramFileName of fileNames) {
        const fullPath: string = path.join(folder, paramFileName);
        const uri: Uri = Uri.file(fullPath);
        if (await isParameterFile(fullPath) && templateUri.fsPath !== fullPath) {
          paths.push({
            uri,
            friendlyPath: getRelativeParameterFilePath(templateUri, uri),
            isCloseNameMatch: mayBeMatchingParameterFile(templateUri.fsPath, fullPath)
          });
        }
      }
    } catch (error) {
      // Ignore
    }

    return paths;
  })
    // tslint:disable-next-line: strict-boolean-expressions
    || [];
}

async function isParameterFile(filePath: string): Promise<boolean> {
  try {
    if (!hasSupportedParameterFileExtension(filePath)) {
      return false;
    }

    if (await doesFileContainString(filePath, containsParametersSchema, readAtMostBytesToFindParamsSchema)) {
      return true;
    }
  } catch (error) {
    // Ignore
  }

  return false;
}

async function doesFileContainString(filePath: string, matches: (fileSubcontents: string) => boolean, maxBytesToRead: number): Promise<boolean> {
  // tslint:disable-next-line: typedef
  return new Promise<boolean>((resolve, reject) => {
    const stream = fse.createReadStream(filePath, { encoding: 'utf8' });

    let content: string = '';
    stream.on('data', (chunk: string) => {
      content += chunk;
      if (matches(content)) {
        stream.close();
        resolve(true);
      }

      if (content.length >= maxBytesToRead) {
        stream.close();
        resolve(false);
      }
    });
    stream.on('end', () => {
      resolve(false);
    });
    stream.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Determines if a file is likely a parameter file for the given template file, based on name.
 * Common patterns are:
 *   template.json, template.params.json
 *   template.json, template.parameters.json
 */
export function mayBeMatchingParameterFile(templateFileName: string, parameterFileName: string): boolean {
  if (!hasSupportedParameterFileExtension(parameterFileName)) {
    return false;
  }

  const baseTemplateName = removeAllExtensions(path.basename(templateFileName)).toLowerCase();
  const baseParamsName = removeAllExtensions(path.basename(parameterFileName)).toLowerCase();

  return baseParamsName.startsWith(baseTemplateName);
}

function removeAllExtensions(fileName: string): string {
  return fileName.replace(/\..+$/, '');
}

/**
 * Search for potential parameter file matches for the given document, and ask the user if appropriate whether to associate it
 */
export function considerQueryingForParameterFile(mapping: DeploymentFileMapping, document: TextDocument): void {
  // Only deal with saved files, because we don't have an accurate
  //   URI that we can track for unsaved files, and it's a better user experience. asdf
  if (document.uri.scheme !== 'file') {
    return;
  }

  const templateUri = document.uri;
  const templatPath = templateUri.fsPath;
  const alreadyHasParamFile: boolean = !!mapping.getParameterFile(document.uri); //asdf
  //asdf const alwaysUseMatchingParameterFile = ext.configuration.get<boolean>(configKeys.alwaysUseMatchingParameterFile);

  // tslint:disable-next-line: no-floating-promises Don't wait
  callWithTelemetryAndErrorHandling('queryAddParameterFile', async (actionContext: IActionContext): Promise<void> => {
    actionContext.telemetry.properties.alreadyHasParamFile = String(alreadyHasParamFile);
    //asdf actionContext.telemetry.properties.alwaysUseMatchingParameterFile = String(alwaysUseMatchingParameterFile);

    if (alreadyHasParamFile) {
      return;
    }

    if (!canAsk(templateUri, actionContext)) {
      return;
    }

    const suggestions = await findSuggestedParameterFiles(document.uri); //asdf optimize for single-file case
    const closeMatches = suggestions.filter(pf => pf.isCloseNameMatch);
    actionContext.telemetry.measurements.closeMatches = closeMatches.length;
    actionContext.telemetry.measurements.totalFound = suggestions.length;

    // Take the shortest as the most likely best match
    const closestMatch: IPossibleParameterFile | undefined = closeMatches.length > 0 ? closeMatches.sort(pf => -pf.uri.fsPath.length)[0] : undefined;
    if (!closestMatch) {
      // No likely matches, so don't ask
      return;
    }

    // Is there just a single match?
    actionContext.telemetry.properties.automaticallyUsingMatchingParamFile = 'false';
    if (closeMatches.length === 1 && !closestMatch.fileNotFound /*asdf&& alwaysUseMatchingParameterFile*/) {
      //asdf actionContext.telemetry.properties.automaticallyUsingMatchingParamFile = 'true';
      ext.outputChannel.appendLine(`Found matching parameter file: "${templatPath}" -> "${closestMatch.uri.fsPath}"`);
      //asdf
      // Don't store this in settings, since we picked it automatically. If the file is deleted or renamed, or another is
      //   added, saving it in settings would prevent us from picking up the new one automatically
      // // if (!ext.context.globalState.get<boolean>(globalStateKeys.alreadyToldAboutUseMatchingParamFiles)) {
      // //   window.showInformationMessage(
      // //     `Found a matching parameter file "${closestMatch.uri.fsPath}". `
      // //   ); // Don't wait
      //   await ext.context.globalState.update(globalStateKeys.alreadyToldAboutUseMatchingParamFiles, true);
      // }

      await mapping.mapParameterFile(templateUri, closestMatch.uri, { saveInSettings: false }); //asdf
      return;
    }

    const neverForThisFile: MessageItem = { title: "Never for this file" };
    const choose: MessageItem = { title: "Choose File..." };

    const response: MessageItem | undefined = await window.showInformationMessage(
      `Multiple matching parameter files have been been detected. Would you like to choose one? This will enable additional functionality, such as more complete validation.`,
      choose,
      neverForThisFile,
    );
    if (!response) {
      actionContext.telemetry.properties.response = 'Canceled';
      throw new UserCancelledError();
    }

    actionContext.telemetry.properties.response = response.title;

    switch (response.title) {
      case neverForThisFile.title:
        // We won't ask again
        await dontAskAboutThisFile(templateUri, actionContext);

        // Let them know how to do it manually
        // Don't wait for an answer
        window.showInformationMessage(howToMessage);
        break;
      case choose.title:
        await commands.executeCommand("azurerm-vscode-tools.selectParameterFile", templateUri);
        break;
      default:
        assert("considerQueryingForParameterFile: Unexpected response");
        break;
    }
  });
}

function canAsk(templateUri: Uri, actionContext: IActionContext): boolean {
  const checkForMatchingParamFilesSetting: boolean = !!ext.configuration.get<boolean>(configKeys.checkForMatchingParameterFiles);
  actionContext.telemetry.properties.checkForMatchingParamFiles = String(checkForMatchingParamFilesSetting);
  if (!checkForMatchingParamFilesSetting) {
    return false;
  }

  // tslint:disable-next-line: strict-boolean-expressions
  //asdf const neverAskFiles: string[] = ext.context.globalState.get<string[]>(globalStateKeys.dontAskAboutParameterFiles) || [];
  //const key = normalizePath(templateUri);
  //asdf
  // if (neverAskFiles.includes(key)) {
  //   actionContext.telemetry.properties.isInDontAskList = 'true';
  //   return false;
  // }

  //asdfs
  // let ignoreThisSession = _filesToIgnoreThisSession.has(normalizePath(templateUri));
  // if (ignoreThisSession) {
  //   actionContext.telemetry.properties.ignoreThisSession = 'true';
  //   return false;
  // }

  return true;
}

function dontAskAgainThisSession(templateUri: Uri, actionContext: IActionContext): void {
  _filesToIgnoreThisSession.add(normalizePath(templateUri));
}

async function dontAskAboutThisFile(templateUri: Uri, actionContext: IActionContext): Promise<void> {
  // asdf comment
  await ext.deploymentFileMapping.value.mapParameterFile(templateUri, undefined, { saveInSettings: true });

  //asdf
  // const neverAskFiles: string[] = ext.context.globalState.get<string[]>(globalStateKeys.dontAskAboutParameterFiles) || [];
  // const key: string = normalizePath(templateUri);
  // neverAskFiles.push(key);
  // await ext.context.globalState.update(globalStateKeys.dontAskAboutParameterFiles, neverAskFiles);
  // ext.configuration.update
}

function hasSupportedParameterFileExtension(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  return extension === '.json' || extension === '.jsonc';
}
