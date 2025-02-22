import {getApp, initializeApp} from 'firebase/app';
import {getFunctions, connectFunctionsEmulator, httpsCallable} from 'firebase/functions';
import {getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithCredential, signOut} from 'firebase/auth';

import * as constants from './constants';
import {fetchWithProgress, FetchWithProgressResponse} from './fetchWithProgress';
import {corsUrl, FileAPI, OnProgressParams} from './fileUtils';
import {
    DriveFileShortcut,
    DriveMetadata,
    DriveUser,
    isDriveFileShortcut,
    isWebLinkProperties
} from './googleDriveUtils';
import {promiseSleep} from './promiseSleep';

// The API Key and Client ID are set up in https://console.developers.google.com/
// API key has the following APIs enabled: Google Drive API, Identity Toolkit API
const API_KEY = 'AIzaSyDyeV-r65-Iv-iVSwSczguOBF_sRZY9wok';
// Client ID has Authorised JavaScript origins set to http://localhost:3000 (for local dev), as well as the site where
// users load the client.
const CLIENT_ID = '467803009036-2jo3nhds25lc924suggdl3jman29vt0s.apps.googleusercontent.com';

// The Firebase project was created based on the existing project.  It's configured with a web app, and a realtime
// database and functions added. Authentication for the Firebase project also has Google added as a sign-in method, with
// the original project's client ID whitelisted.
const FIREBASE_API_KEY = 'AIzaSyDo5DaDvRUW2tT4YwbXjfKkvjG_r8sLPUk';

// Discovery docs for the Google Drive API.
const DISCOVERY_DOCS = ['https://www.googleapis.com/discovery/v1/apis/drive/v3/rest'];
// Authorization scopes required by the API; multiple scopes can be included, separated by spaces.
const SCOPES = 'https://www.googleapis.com/auth/drive.file email openid profile';

// Firebase configuration.
export const firebaseApp = initializeApp({
    apiKey: FIREBASE_API_KEY,
    projectId: 'virtual-gaming-tabletop',
    authDomain: 'virtual-gaming-tabletop.firebaseapp.com',
    appId: '1:467803009036:web:4e149ef739fbbe9c4ffe29',
    databaseURL: 'https://virtual-gaming-tabletop-default-rtdb.firebaseio.com'
});

const functions = getFunctions(getApp());
if (process.env.REACT_APP_FIREBASE_EMULATOR === 'true') {
    connectFunctionsEmulator(functions, 'localhost', 5001);
}

const fileFields = 'id, name, mimeType, properties, appProperties, thumbnailLink, trashed, parents, owners, resourceKey';

interface GoogleApiFileResult {
    id?: string;
    files: DriveMetadata[];
    nextPageToken?: string;
}

interface GoogleApiUserResult {
    user: DriveUser;
}

interface GoogleApiResponse<T = GoogleApiFileResult> {
    result: T;
    body: string;
    headers: object;
    status: number;
    statusText: string;
}

function getResult<T>(response: GoogleApiResponse<T>): T {
    if (response.status >= 200 && response.status < 300) {
        return response.result;
    } else {
        throw response;
    }
}

export function getAuthorisation() {
    const token = gapi.client.getToken();
    return 'Bearer ' + token.access_token;
}

/**
 * Handle our fake shortcut files explicitly.
 *
 * @param {DriveMetadata} shortcutMetadata The metadata of a shortcut file.
 * @return {Promise<DriveMetadata | null>} A promise of the file the shortcut points at (but in the directory of the
 * shortcut and with a merge of properties from the original and the shortcut), or null if the file is not available.
 */
async function getShortcutHack(shortcutMetadata: DriveMetadata<void, DriveFileShortcut>): Promise<DriveMetadata | null> {
    try {
        const realMetadata = await googleAPI.getFullMetadata(shortcutMetadata.properties.shortcutMetadataId);
        // Perform on-the-fly migration of original appProperties to properties.
        const properties = (realMetadata.appProperties && realMetadata.appProperties['width'] !== undefined) ? realMetadata.appProperties : realMetadata.properties;
        return {
            ...realMetadata,
            properties: {...properties, ...shortcutMetadata.properties, ownedMetadataId: shortcutMetadata.id},
            parents: shortcutMetadata.parents,
            name: shortcutMetadata.name
        };
    } catch (err) {
        if (err.status === 404) {
            return null;
        }
        console.error('Error following shortcut', err);
        throw new Error('Error following shortcut: ' + err.status);
    }
}

/**
 * If we get a metadata reference to someone else's file, it won't have parents set... check if we have any local
 * shortcuts to it, and if so, set parents as appropriate.
 *
 * @param {DriveMetadata} realMetadata The metadata, which may be owned by someone else
 * @return {Promise<DriveMetadata>} Either the same metadata, or (if we have a shortcut) the metadata with parents set
 */
async function getReverseShortcutHack(realMetadata: DriveMetadata): Promise<DriveMetadata> {
    if (!realMetadata.parents) {
        const shortcutMetadatas = await googleAPI.findFilesWithProperty('shortcutMetadataId', realMetadata.id);
        const parents = (!shortcutMetadatas) ? []
            : shortcutMetadatas.reduce((parents: string[], shortcut) => (
                parents.concat(shortcut.parents)
            ), []);
        realMetadata = {...realMetadata, parents};
    }
    return realMetadata;
}

// ================================================================================

/**
 * Apparently the javascript implementation of the Google Rest API doesn't implement all this for uploading files?
 */
async function resumableUpload(location: string, file: Blob, response: Response | FetchWithProgressResponse | null, onProgress?: (progress: OnProgressParams) => void): Promise<DriveMetadata> {
    let options: any = {
        method: 'PUT',
        headers: {}
    };
    if (response === null) {
        options.body = file;
    } else {
        switch (response.status) {
            case 200:
            case 201:
                const {id} = await response.json();
                return await googleAPI.getFullMetadata(id);
            case 308:
            case 503:
                let range = response.headers.get('range');
                if (range) {
                    let resume = Number(range.split('-').pop()) + 1;
                    options.body = file.slice(resume);
                    options.headers['Content-Range'] = `${resume}-${file.size}/${file.size}`;
                } else {
                    options.body = file;
                    options.headers['Content-Range'] = `*/${file.size}`;
                }
                break;
            default:
                throw response;
        }
    }
    const progressResponse = await fetchWithProgress(location, options, onProgress);
    return await resumableUpload(location, file, progressResponse, onProgress);
}

// ================================================================================

function addGapiScript() {
    return new Promise((resolve, reject) => {
        const iframe = document.createElement('iframe');
        iframe.setAttribute('width', '0');
        iframe.setAttribute('height', '0');
        iframe.onload = () => {
            if (!iframe || !iframe.contentDocument || !iframe.contentWindow) {
                reject(new Error('Failed to add iframe'));
                return;
            }
            const script = iframe.contentDocument.createElement('script');
            script.onload = () => {
                resolve(iframe.contentWindow!['gapi']);
            };
            script.onerror = reject;
            script.src = 'https://apis.google.com/js/api.js';
            iframe.contentDocument.head.appendChild(script);
        };
        iframe.onerror = reject;
        iframe.src = process.env.PUBLIC_URL + '/blank.html';
        document.body.appendChild(iframe);
    });
}

async function initialiseGapi(gapi: any) {
    await new Promise((callback, onerror) => {
        gapi.load('client', {callback, onerror})
    });
    await gapi.client.init({
        apiKey: API_KEY,
        discoveryDocs: DISCOVERY_DOCS
    });
}

// ================================================================================

const gapi: any = window['gapi']; // Standard version of GAPI
let anonymousGapi: any = window['anonymousGapi']; // Version in an iframe
const google: any = window['google']; // GIS client
let oauthClient: any;
let currentSignInHandler: (signedIn: boolean) => void;

// Firebase functions
const handleOAuthCode = httpsCallable<{code: string}, {accessToken: string, successCode: string}>(functions, 'handleOAuthCode');
const handleOAuthSuccess = httpsCallable<{successCode: string}, void>(functions, 'handleOAuthSuccess');
const refreshAccessToken = httpsCallable<void, {access_token: string}>(functions, 'refreshAccessToken');
const gToveSignOut = httpsCallable(functions, 'gToveSignOut');

const googleAPI: FileAPI = {

    initialiseFileAPI: async (signInHandler, onError) => {
        currentSignInHandler = signInHandler;
        try {
            // Jump through some hoops to get two copies of gapi.  One will remain "anonymous", i.e. does not log in
            window['anonymousGapi'] = anonymousGapi = anonymousGapi || await addGapiScript();
            await initialiseGapi(anonymousGapi);
            await initialiseGapi(gapi);
            // Set up auth changed callback, which handles returning users
            onAuthStateChanged(getAuth(), async (user) => {
                if (user && !gapi.client.getToken()?.access_token) {
                    try {
                        const result = await refreshAccessToken();
                        gapi.client.setToken(result.data);
                        signInHandler(true);
                    } catch (error) {
                        // Ignore errors here, since we're just trying to signin in the background.
                    }
                }
            });
            // Create an oauthClient to popup a prompt for the user to grant access.
            oauthClient = google.accounts.oauth2.initCodeClient({
                client_id: CLIENT_ID,
                scope: SCOPES,
                ux_mode: 'popup',
                callback: async (resp: any) => {
                    try {
                        // Submit the oAuth authentication code and get an access_token
                        const result = await handleOAuthCode({code: resp.code});
                        const {accessToken, successCode} = result.data;
                        gapi.client.setToken({access_token: accessToken});
                        // Also authenticate to Firebase
                        const credential = GoogleAuthProvider.credential(null, accessToken);
                        await signInWithCredential(getAuth(), credential);
                        await handleOAuthSuccess({successCode});
                        signInHandler(true);
                    } catch (error) {
                        onError(error);
                    }
                }
            });
            signInHandler(false);
        } catch (err) {
            onError(err);
        }
    },

    signInToFileAPI: () => {
        oauthClient.requestCode();
    },

    signOutFromFileAPI: async () => {
        const token = gapi.client.getToken();
        if (token) {
            await gToveSignOut();
            await signOut(getAuth());
            gapi.client.setToken({});
        }
        currentSignInHandler(false);
    },

    getLoggedInUserInfo: async () => {
        const response = await gapi.client.drive.about.get({fields: 'user'}) as GoogleApiResponse<GoogleApiUserResult>;
        return getResult(response).user;
    },

    loadRootFiles: async (addFilesCallback): Promise<void> => {
        const result = await googleAPI.findFilesWithAppProperty('rootFolder', 'true');
        if (result.length > 0) {
            // Handle the case where the root folder has been renamed
            result[0].name = constants.FOLDER_ROOT;
            addFilesCallback(result);
            return await googleAPI.loadFilesInFolder(result[0].id, addFilesCallback);
        } else {
            return undefined;
        }
    },

    loadFilesInFolder: async (id: string, addFilesCallback) => {
        let pageToken = undefined;
        do {
            const response = await gapi.client.drive.files.list({
                q: `'${id}' in parents and trashed=false`,
                pageToken,
                fields: `nextPageToken, files(${fileFields})`
            }) as GoogleApiResponse;
            const result = getResult(response);
            const addedFiles = [];
            for (let file of result.files) {
                const actualFile = isDriveFileShortcut(file) ? await getShortcutHack(file) : file;
                if (actualFile) {
                    addedFiles.push(actualFile);
                }
            }
            if (addedFiles.length > 0) {
                addFilesCallback(addedFiles);
            }
            pageToken = result.nextPageToken;
        } while (pageToken !== undefined);
    },

    getFullMetadata: async (fileId, resourceKey) => {
        const response = await driveFilesGet({fileId, fields: fileFields, resourceKey});
        const metadata = getResult(response);
        if (isDriveFileShortcut(metadata)) {
            return (await getShortcutHack(metadata))!;
        } else  {
            return getReverseShortcutHack(metadata);
        }
    },

    getFileModifiedTime: async (fileId): Promise<number> => {
        const response = await driveFilesGet({fileId, fields: 'modifiedTime'});
        const result = getResult(response);
        return Date.parse(result['modifiedTime']);
    },

    createFolder: async (folderName, metadata) => {
        const response = await gapi.client.drive.files.create({
            resource: {
                name: folderName,
                mimeType: constants.MIME_TYPE_DRIVE_FOLDER,
                ...metadata
            },
            fields: 'id'
        }) as GoogleApiResponse;
        const {id} = getResult(response);
        return googleAPI.getFullMetadata(id!);
    },

    /**
     * Create or update a file in Drive
     * @param driveMetadata An object containing metadata for drive: id(optional), name, parents
     * @param file The file instance to upload.
     * @param onProgress Optional callback which is periodically invoked with progress.  The parameter has fields
     *     {loaded, total}
     * @return Promise<any> A promise that resolves to the drivemetadata when the upload has completed.
     */
    uploadFile: async (driveMetadata, file, onProgress) => {
        const authorization = getAuthorisation();
        const options: any = {
            headers: {
                'Authorization': authorization,
                'Content-Type': 'application/json; charset=UTF-8',
                'X-Upload-Content-Length': file.size,
                'X-Upload-Content-Type': file.type
            },
            body: JSON.stringify({...driveMetadata, id: undefined})
        };
        let location;
        if (driveMetadata.id) {
            location = `https://www.googleapis.com/upload/drive/v3/files/${driveMetadata.id}?uploadType=resumable`;
            options.method = 'PATCH';
        } else {
            location = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable';
            options.method = 'POST';
        }
        const response = await fetch(location, options);
        location = response.headers.get('location');
        if (response.ok && location) {
            return resumableUpload(location, file, null, onProgress);
        } else {
            throw response;
        }
    },

    saveJsonToFile: (idOrMetadata, json) => {
        const blob = new Blob([JSON.stringify(json)], {type: constants.MIME_TYPE_JSON});
        const driveMetadata = (typeof(idOrMetadata) === 'string') ? {id: idOrMetadata} : idOrMetadata;
        return googleAPI.uploadFile(driveMetadata, blob);
    },

    uploadFileMetadata: async (metadata, addParents?: string[], removeParents?: string[]) => {
        const properties = metadata.properties === undefined ? undefined : Object.keys(metadata.properties).reduce((cleaned, key) => {
            cleaned[key] = (typeof(metadata.properties![key]) === 'object') ? JSON.stringify(metadata.properties![key]) : metadata.properties![key];
            return cleaned;
        }, {});
        const response = await (!metadata.id ?
            gapi.client.drive.files.create(metadata)
            :
            gapi.client.drive.files.update({
                fileId: metadata.id,
                name: metadata.name,
                appProperties: metadata.appProperties,
                properties,
                addParents: addParents ? addParents.join(',') : undefined,
                removeParents: removeParents ? removeParents.join(',') : undefined
            }));
        const {id} = getResult(response);
        return await googleAPI.getFullMetadata(id);
    },

    createShortcut: async (originalFile: Partial<DriveMetadata> & {id: string}, parents: string[]) => {
        // Note: need to accommodate fromBundleId in originalFile somehow
        // Manually emulate shortcuts using properties, rather than using native metadata.shortcutDetails.
        const ownedMetadata = await googleAPI.uploadFileMetadata({
            name: originalFile.name,
            properties: {...originalFile.properties, shortcutMetadataId: originalFile.id} as any,
            parents
        });
        return {...ownedMetadata, properties: {...originalFile.properties, shortcutMetadataId: originalFile.id,
                ownedMetadataId: ownedMetadata.id}};
    },

    getFileContents: async (metadata) => {
        const fullMetadata = (metadata.appProperties || metadata.properties) ? metadata : await googleAPI.getFullMetadata(metadata.id!, metadata.resourceKey);
        if (isWebLinkProperties(fullMetadata.properties)) {
            const response = await fetch(corsUrl(fullMetadata.properties.webLink!), {
                headers: {'X-Requested-With': 'https://github.com/RobRendell/gTove'}
            });
            return await response.blob();
        } else {
            const response = await driveFilesGet({fileId: fullMetadata.id!, alt: 'media', resourceKey: fullMetadata.resourceKey});
            const bodyArray = new Uint8Array(response.body.length);
            for (let index = 0; index < response.body.length; ++index) {
                bodyArray[index] = response.body.charCodeAt(index);
            }
            return new Blob(
                [ bodyArray ],
                { type: response.headers['Content-Type'] || undefined }
            );
        }
    },

    getJsonFileContents: async (metadata) => {
        const response = await driveFilesGet({fileId: metadata.id!, alt: 'media', resourceKey: metadata.resourceKey});
        return getResult(response);
    },

    makeFileReadableToAll: (metadata) => {
        return gapi.client.drive.permissions
            .create({
                fileId: metadata.id,
                role: 'reader',
                type: 'anyone'
            });
    },

    findFilesWithAppProperty: async (key: string, value: string) => {
        return await findFilesWithQuery(`appProperties has {key='${key}' and value='${value}'} and trashed=false`);
    },

    findFilesWithProperty: async (key: string, value: string) => {
        return await findFilesWithQuery(`properties has {key='${key}' and value='${value}'} and trashed=false`);
    },

    findFilesContainingNameWithProperty: async (name: string, key: string, value: string) => {
        const nameEscaped = name.replace("'", "\\'");
        return await findFilesWithQuery(`name contains '${nameEscaped}' and properties has {key='${key}' and value='${value}'} and trashed=false`, true);
    },

    deleteFile: async (metadata) => {
        // Need to handle deleting shortcut files.
        if (!metadata.owners) {
            metadata = await googleAPI.getFullMetadata(metadata.id!);
        }
        const ownedByMe = metadata.owners && metadata.owners.reduce((me, owner) => (me || owner.me), false);
        if (ownedByMe) {
            await gapi.client.drive.files.update({
                fileId: metadata.id,
                trashed: true
            });
        } else {
            const shortcutFiles = await googleAPI.findFilesWithProperty('shortcutMetadataId', metadata.id!);
            const metadataParents = metadata.parents;
            const shortcut = metadataParents ? shortcutFiles.find((shortcut) => (
                shortcut.parents.length === metadataParents.length
                && shortcut.parents.reduce<boolean>((match, parentId) => (match && metadataParents.indexOf(parentId) >= 0), true)
            )) : null;
            if (shortcut) {
                await googleAPI.deleteFile(shortcut);
            }
        }
    }

};

/**
 * Wrap any function, and if it returns a promise, catch errors and retry with exponential backoff.
 *
 * @param fn The function to wrap so that it retries if it rejects with an appropriate error
 * @return The return result of the wrapped function, potentially after several retries.
 */
function retryErrors<T extends Function>(fn: T): T {
    return function(...args: any[]) {
        const retryFunction = (args: any[], delay: number) => {
            const result = fn(...args);
            return (!result || !result.catch) ? result :
                result.catch(async (error: any) => {
                    if (error.status === 401) {
                        await promiseSleep(delay);
                        gapi.client.setToken(await refreshAccessToken());
                        return retryFunction(args, Math.min(30000, 2 * delay));
                    } else if (error.status === 403) {
                        return promiseSleep(delay)
                            .then(() => (retryFunction(args, Math.min(30000, 2 * delay))));
                    } else {
                        throw error;
                    }
                });
        };
        return retryFunction(args, 500);
    } as any;
}

// Augment each function so it retries if Drive throws a 403 due to rate limits.
Object.keys(googleAPI).forEach((functionName) => {
    googleAPI[functionName] = retryErrors(googleAPI[functionName]);
});

async function driveFilesGet(params: {[field: string]: string | undefined}): Promise<GoogleApiResponse<DriveMetadata>> {
    // Do a regular drive.files.get, but fall back to anonymous if it throws a 404 error
    try {
        return await gapi.client.drive.files.get(params);
    } catch (err) {
        if (err.status === 404) {
            // Attempt to get the file data anonymously
            return await anonymousGapi.client.drive.files.get(params);
        }
        throw err;
    }
}

async function findFilesWithQuery(query: string, expandShortcuts?: boolean): Promise<DriveMetadata[]> {
    let result: DriveMetadata[] = [];
    let nextPageToken = undefined;
    do {
        const response = await gapi.client.drive.files.list({
            q: query,
            pageToken: nextPageToken,
            fields: `nextPageToken, files(${fileFields})`
        }) as GoogleApiResponse<GoogleApiFileResult>;
        const page = getResult(response);
        for (let file of page.files) {
            const actualFile = !expandShortcuts ? file : isDriveFileShortcut(file) ? await getShortcutHack(file) : await getReverseShortcutHack(file);
            if (actualFile) {
                result.push(actualFile);
            }
        }
        nextPageToken = page.nextPageToken;
    } while (nextPageToken !== undefined);
    return result;
}


export default googleAPI;