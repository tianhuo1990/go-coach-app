package cn.gocoach.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Locale;

public class MainActivity extends Activity {
    private WebView web;
    private Engine engine;
    private TextToSpeech tts;
    private boolean ttsReady = false;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= 21) getWindow().setStatusBarColor(Color.parseColor("#f3efe6"));

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#f3efe6"));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setTextZoom(100);
        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient());
        web.addJavascriptInterface(new Bridge(), "Native");
        setContentView(web);

        engine = new Engine(this, st -> callJs("window.__engineStatus && window.__engineStatus(" + JSONObject.quote(st) + ")"));
        engine.start(false);

        tts = new TextToSpeech(this, status -> {
            if (status == TextToSpeech.SUCCESS) {
                int r = tts.setLanguage(Locale.SIMPLIFIED_CHINESE);
                ttsReady = r != TextToSpeech.LANG_MISSING_DATA && r != TextToSpeech.LANG_NOT_SUPPORTED;
                if (!ttsReady) ttsReady = tts.setLanguage(Locale.CHINESE) >= 0;
            }
        });

        web.loadUrl("file:///android_asset/www/index.html");
    }

    private void callJs(final String js) {
        runOnUiThread(() -> { if (web != null) web.evaluateJavascript(js, null); });
    }

    private void callback(String id, String payload) {
        callJs("window.__nativeCb && window.__nativeCb(" + JSONObject.quote(id) + "," + JSONObject.quote(payload) + ")");
    }

    @Override
    public void onBackPressed() {
        callJs("window.__onBack ? window.__onBack() : 0");
    }

    @Override
    protected void onDestroy() {
        if (engine != null) engine.stop();
        if (tts != null) tts.shutdown();
        if (web != null) web.destroy();
        super.onDestroy();
    }

    /** 给网页调用的接口 */
    public class Bridge {
        @JavascriptInterface
        public void analyze(String queryJson, String cbId) {
            engine.analyze(queryJson, res -> callback(cbId, res));
        }

        @JavascriptInterface
        public String engineStatus() { return engine.getStatus(); }

        @JavascriptInterface
        public void restartEngine(boolean forceCpu) { engine.restart(forceCpu); }

        /** 网络请求由原生代码发出，避免网页的跨域和明文 http 限制 */
        @JavascriptInterface
        public void http(final String url, final String headersJson, final String body, final String cbId) {
            new Thread(() -> {
                JSONObject out = new JSONObject();
                HttpURLConnection c = null;
                try {
                    c = (HttpURLConnection) new URL(url).openConnection();
                    c.setConnectTimeout(15000);
                    c.setReadTimeout(90000);
                    c.setRequestMethod(body == null || body.isEmpty() ? "GET" : "POST");
                    JSONObject h = new JSONObject(headersJson == null || headersJson.isEmpty() ? "{}" : headersJson);
                    Iterator<String> it = h.keys();
                    while (it.hasNext()) { String k = it.next(); c.setRequestProperty(k, h.getString(k)); }
                    if (body != null && !body.isEmpty()) {
                        c.setDoOutput(true);
                        try (OutputStream os = c.getOutputStream()) { os.write(body.getBytes(StandardCharsets.UTF_8)); }
                    }
                    int code = c.getResponseCode();
                    InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
                    ByteArrayOutputStream bo = new ByteArrayOutputStream();
                    if (in != null) {
                        byte[] buf = new byte[8192];
                        int n;
                        while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
                        in.close();
                    }
                    out.put("status", code);
                    out.put("body", new String(bo.toByteArray(), StandardCharsets.UTF_8));
                } catch (Exception e) {
                    try { out.put("status", 0); out.put("error", String.valueOf(e.getMessage())); } catch (Exception ignored) {}
                } finally {
                    if (c != null) c.disconnect();
                }
                callback(cbId, out.toString());
            }, "http").start();
        }

        @JavascriptInterface
        public boolean speak(String text) {
            if (!ttsReady || tts == null) return false;
            tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "gc");
            return true;
        }

        @JavascriptInterface
        public void stopSpeak() { if (tts != null) tts.stop(); }

        @JavascriptInterface
        public void exitApp() { runOnUiThread(() -> finish()); }
    }
}
