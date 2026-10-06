package com.parthavi.tradedesk;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.Window;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

public class MainActivity extends Activity {
    private WebView webView;
    private DownloadManager downloadManager;
    private long updateDownloadId = -1L;
    private BroadcastReceiver downloadReceiver;
    private boolean receiverRegistered = false;
    private boolean updateDialogShown = false;

    private static final String START_URL =
            "https://parthavi-trade-desk-pro.onrender.com/?source=android_app";
    private static final String UPDATE_JSON_URL =
            "https://parthavi-trade-desk-pro.onrender.com/app-update.json";
    private static final String APK_FILE_NAME = "parthavi-trade-desk-pro-update.apk";
    private static final int APP_VERSION_CODE = 4;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window window = getWindow();
        window.setStatusBarColor(Color.rgb(5, 8, 18));
        window.setNavigationBarColor(Color.BLACK);

        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setLoadWithOverviewMode(false);
        settings.setUseWideViewPort(false);
        settings.setSupportZoom(false);
        settings.setDefaultFontSize(16);
        settings.setMediaPlaybackRequiresUserGesture(false);

        webView.addJavascriptInterface(new HapticBridge(), "PTDHaptics");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme();
                if ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)) {
                    return false;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                installHapticClickScript(view);
            }
        });
        webView.setWebChromeClient(new WebChromeClient());
        webView.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));
        setContentView(webView);

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(START_URL);
        }

        new Handler(Looper.getMainLooper()).postDelayed(this::checkForUpdate, 3500);
    }

    private void installHapticClickScript(WebView view) {
        view.evaluateJavascript(
                "(function(){try{window.scrollTo(0,0);document.documentElement.scrollLeft=0;document.body.scrollLeft=0;}catch(e){}})();",
                null
        );
    }

    private final class HapticBridge {
        @JavascriptInterface
        public void tap() {
            runOnUiThread(() -> {
                try {
                    android.os.Vibrator vibrator =
                            (android.os.Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
                    if (vibrator == null) return;
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        vibrator.vibrate(android.os.VibrationEffect.createOneShot(
                                12L,
                                android.os.VibrationEffect.DEFAULT_AMPLITUDE
                        ));
                    } else {
                        vibrator.vibrate(12L);
                    }
                } catch (Exception ignored) {
                }
            });
        }
    }

    private void checkForUpdate() {
        new Thread(() -> {
            HttpURLConnection connection = null;
            try {
                URL url = new URL(UPDATE_JSON_URL + "?t=" + System.currentTimeMillis());
                connection = (HttpURLConnection) url.openConnection();
                connection.setConnectTimeout(7000);
                connection.setReadTimeout(7000);
                connection.setUseCaches(false);
                connection.setRequestProperty("Cache-Control", "no-cache");
                connection.setRequestProperty("Accept", "application/json");

                int code = connection.getResponseCode();
                if (code < 200 || code >= 300) return;

                StringBuilder body = new StringBuilder();
                try (InputStream in = connection.getInputStream();
                     BufferedReader reader = new BufferedReader(new InputStreamReader(in))) {
                    String line;
                    while ((line = reader.readLine()) != null) body.append(line);
                }

                JSONObject update = new JSONObject(body.toString());
                int remoteCode = update.optInt("versionCode", 0);
                String remoteName = update.optString("versionName", "");
                String apkUrl = update.optString("apkUrl", "");
                String notes = update.optString("notes", "New PARTHAVI TRADE DESK PRO update is available.");

                if (remoteCode > APP_VERSION_CODE && apkUrl.startsWith("https://")) {
                    runOnUiThread(() -> showUpdateDialog(remoteName, notes, apkUrl));
                }
            } catch (Exception ignored) {
                // Update checks are best-effort. The trading app must keep opening even offline.
            } finally {
                if (connection != null) connection.disconnect();
            }
        }).start();
    }

    private void showUpdateDialog(String versionName, String notes, String apkUrl) {
        if (isFinishing() || updateDialogShown) return;
        updateDialogShown = true;

        new AlertDialog.Builder(this)
                .setTitle("PARTHAVI TRADE DESK PRO • Update")
                .setMessage("New version " + (versionName.isEmpty() ? "available" : versionName) + "\n\n" + notes)
                .setNegativeButton("Later", (d, w) -> updateDialogShown = false)
                .setPositiveButton("UPDATE NOW", (d, w) -> {
                    updateDialogShown = false;
                    startApkDownload(apkUrl);
                })
                .setOnDismissListener(d -> updateDialogShown = false)
                .show();
    }

    private boolean installPermissionReady() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            return getPackageManager().canRequestPackageInstalls();
        }
        return true;
    }

    private void openInstallPermissionSettings() {
        try {
            Intent intent = new Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getPackageName())
            );
            startActivity(intent);
            Toast.makeText(this, "Allow 'Install unknown apps' for PARTHAVI TRADE DESK PRO, then tap UPDATE again.", Toast.LENGTH_LONG).show();
        } catch (Exception e) {
            startActivity(new Intent(Settings.ACTION_SECURITY_SETTINGS));
        }
    }

    private void startApkDownload(String apkUrl) {
        try {
            java.io.File oldApk = new java.io.File(
                    getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS),
                    APK_FILE_NAME
            );
            if (oldApk.exists()) oldApk.delete();
            if (downloadManager == null) {
                downloadManager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            }

            registerDownloadReceiverIfNeeded();

            Uri source = Uri.parse(apkUrl);
            DownloadManager.Request request = new DownloadManager.Request(source);
            request.setTitle("PARTHAVI TRADE DESK PRO Update");
            request.setDescription("Downloading Android app update…");
            request.setMimeType("application/vnd.android.package-archive");
            request.setNotificationVisibility(
                    DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED
            );
            request.setAllowedOverMetered(true);
            request.setAllowedOverRoaming(true);
            request.setDestinationInExternalFilesDir(
                    this,
                    Environment.DIRECTORY_DOWNLOADS,
                    APK_FILE_NAME
            );

            updateDownloadId = downloadManager.enqueue(request);
            Toast.makeText(this, "Update download started…", Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(this, "Update download failed: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private void registerDownloadReceiverIfNeeded() {
        if (receiverRegistered) return;

        downloadReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L);
                if (id != updateDownloadId) return;
                installDownloadedApk();
            }
        };

        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(downloadReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(downloadReceiver, filter);
        }
        receiverRegistered = true;
    }

    private void installDownloadedApk() {
        if (!installPermissionReady()) {
            openInstallPermissionSettings();
            return;
        }
        try {
            java.io.File apk = new java.io.File(
                    getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS),
                    APK_FILE_NAME
            );
            if (!apk.exists() || apk.length() < 10000L) {
                Toast.makeText(this, "Downloaded update file is missing or invalid.", Toast.LENGTH_LONG).show();
                return;
            }

            Uri apkUri = FileProvider.getUriForFile(
                    this,
                    getPackageName() + ".fileprovider",
                    apk
            );

            Intent installIntent = new Intent(Intent.ACTION_VIEW);
            installIntent.setDataAndType(
                    apkUri,
                    "application/vnd.android.package-archive"
            );
            installIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            installIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

            startActivity(installIntent);
        } catch (Exception e) {
            Toast.makeText(this, "Could not open installer: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        java.io.File apk = new java.io.File(
                getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS),
                APK_FILE_NAME
        );
        if (apk.exists() && apk.length() >= 10000L && installPermissionReady()) {
            new Handler(Looper.getMainLooper()).postDelayed(this::installDownloadedApk, 350);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (receiverRegistered && downloadReceiver != null) {
            try {
                unregisterReceiver(downloadReceiver);
            } catch (Exception ignored) {
            }
            receiverRegistered = false;
        }
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
        }
        super.onDestroy();
    }
}
