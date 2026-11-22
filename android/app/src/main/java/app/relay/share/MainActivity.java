package app.relay.share;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.concurrent.ConcurrentHashMap;

public class MainActivity extends BridgeActivity {
    private final ConcurrentHashMap<String, ActiveDownload> activeDownloads = new ConcurrentHashMap<>();

    private static class ActiveDownload {
        final OutputStream stream;
        final Uri mediaUri;
        final File legacyFile;

        ActiveDownload(OutputStream stream, Uri mediaUri, File legacyFile) {
            this.stream = stream;
            this.mediaUri = mediaUri;
            this.legacyFile = legacyFile;
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (getBridge() != null && getBridge().getWebView() != null) {
            WebView webView = getBridge().getWebView();
            webView.addJavascriptInterface(new RelayFileBridge(), "RelayAndroid");
        }
    }

    @Override
    public void onDestroy() {
        for (String id : activeDownloads.keySet()) {
            abortInternal(id);
        }
        super.onDestroy();
    }

    private void abortInternal(String transferId) {
        ActiveDownload item = activeDownloads.remove(transferId);
        if (item == null) return;
        try {
            item.stream.close();
        } catch (Exception ignored) {}
        try {
            if (item.mediaUri != null) {
                getContentResolver().delete(item.mediaUri, null, null);
            } else if (item.legacyFile != null && item.legacyFile.exists()) {
                //noinspection ResultOfMethodCallIgnored
                item.legacyFile.delete();
            }
        } catch (Exception ignored) {}
    }

    private static String sanitizeFileName(String raw) {
        if (raw == null || raw.trim().isEmpty()) {
            return "file";
        }
        return raw.replaceAll("[\\\\/:*?\"<>|]", "_");
    }

    private static String sanitizeRelativeFolder(String raw) {
        if (raw == null || raw.trim().isEmpty()) {
            return "";
        }
        String normalized = raw.replace('\\', '/');
        String[] parts = normalized.split("/");
        StringBuilder sb = new StringBuilder();
        for (String part : parts) {
            String trimmed = part.trim();
            if (trimmed.isEmpty() || ".".equals(trimmed) || "..".equals(trimmed)) {
                continue;
            }
            String safe = sanitizeFileName(trimmed);
            if (!safe.isEmpty()) {
                if (sb.length() > 0) sb.append('/');
                sb.append(safe);
            }
        }
        return sb.toString();
    }

    public class RelayFileBridge {
        @JavascriptInterface
        public boolean startFile(String transferId, String fileName, String mimeType) {
            return startFileInFolder(transferId, fileName, mimeType, "");
        }

        @JavascriptInterface
        public boolean startFileInFolder(String transferId, String fileName, String mimeType, String relativeFolder) {
            if (transferId == null || transferId.isEmpty()) return false;
            abortInternal(transferId);
            String safeName = sanitizeFileName(fileName);
            String safeFolder = sanitizeRelativeFolder(relativeFolder);
            String safeMime = (mimeType == null || mimeType.isEmpty()) ? "application/octet-stream" : mimeType;

            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentResolver resolver = getContentResolver();
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.Downloads.DISPLAY_NAME, safeName);
                    values.put(MediaStore.Downloads.MIME_TYPE, safeMime);
                    String relPath = safeFolder.isEmpty()
                        ? Environment.DIRECTORY_DOWNLOADS
                        : Environment.DIRECTORY_DOWNLOADS + "/" + safeFolder;
                    values.put(MediaStore.Downloads.RELATIVE_PATH, relPath);
                    values.put(MediaStore.Downloads.IS_PENDING, 1);

                    Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                    if (uri == null) return false;
                    OutputStream os = resolver.openOutputStream(uri);
                    if (os == null) {
                        resolver.delete(uri, null, null);
                        return false;
                    }
                    activeDownloads.put(transferId, new ActiveDownload(os, uri, null));
                    return true;
                } else {
                    File baseDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                    File dir = safeFolder.isEmpty() ? baseDir : new File(baseDir, safeFolder);
                    if (!dir.exists() && !dir.mkdirs()) {
                        return false;
                    }
                    File outFile = new File(dir, safeName);
                    int counter = 1;
                    while (outFile.exists()) {
                        int dot = safeName.lastIndexOf('.');
                        String candidate = dot > 0
                            ? safeName.substring(0, dot) + " (" + counter + ")" + safeName.substring(dot)
                            : safeName + " (" + counter + ")";
                        outFile = new File(dir, candidate);
                        counter++;
                    }
                    OutputStream os = new FileOutputStream(outFile);
                    activeDownloads.put(transferId, new ActiveDownload(os, null, outFile));
                    return true;
                }
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public boolean appendChunk(String transferId, String base64Chunk) {
            ActiveDownload item = activeDownloads.get(transferId);
            if (item == null || base64Chunk == null) return false;
            try {
                byte[] bytes = Base64.decode(base64Chunk, Base64.NO_WRAP);
                item.stream.write(bytes);
                return true;
            } catch (Exception e) {
                abortInternal(transferId);
                return false;
            }
        }

        @JavascriptInterface
        public boolean finishFile(String transferId) {
            ActiveDownload item = activeDownloads.remove(transferId);
            if (item == null) return false;
            try {
                item.stream.flush();
                item.stream.close();
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && item.mediaUri != null) {
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.Downloads.IS_PENDING, 0);
                    getContentResolver().update(item.mediaUri, values, null, null);
                }
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public void abortFile(String transferId) {
            abortInternal(transferId);
        }
    }
}
