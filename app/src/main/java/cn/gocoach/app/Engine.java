package cn.gocoach.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.AssetManager;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 在手机上运行 KataGo 分析引擎。
 * 先试 GPU（OpenCL）版本，启动失败就自动换 CPU 版本，并记住结果。
 */
public class Engine {
    public interface Callback { void done(String json); }
    public interface StatusListener { void status(String s); }

    private static final String TAG = "GoCoachEngine";
    private static final String[] MODELS = {"main.txt", "human.bin"};

    private final Context ctx;
    private final SharedPreferences prefs;
    private final StatusListener listener;

    private Process proc;
    private Writer stdin;
    private volatile boolean ready = false;
    private volatile String status = "引擎准备中…";
    private volatile String backend = "";
    private final Object lock = new Object();
    private final AtomicInteger ids = new AtomicInteger(1);
    private final Map<String, Pending> pending = new HashMap<>();
    private final List<Runnable> waiting = new ArrayList<>();
    private int generation = 0;
    private final StringBuilder gpuLog = new StringBuilder();

    private static final String[] CL_DIRS = {"/vendor/lib64", "/system/vendor/lib64", "/odm/lib64", "/system/lib64",
            "/vendor/lib64/egl", "/system/vendor/lib64/egl", "/vendor/lib64/hw"};
    private static final String[] CL_NAMES = {"libOpenCL.so", "libGLES_mali.so", "libmali.so", "libOpenCL_system.so"};

    private void glog(String s) {
        synchronized (gpuLog) {
            gpuLog.append(s).append('\n');
            if (gpuLog.length() > 6000) gpuLog.delete(0, gpuLog.length() - 6000);
        }
    }

    /** 找手机上的 OpenCL 库；名字不是 libOpenCL.so 的，在 App 目录里建一个同名链接。返回要加进库路径的目录。 */
    private String prepareOpenCl() {
        String found = null;
        for (String d : CL_DIRS) for (String n : CL_NAMES) {
            File f = new File(d, n);
            if (f.exists()) {
                glog("找到 " + f.getAbsolutePath() + (f.canRead() ? "" : "（不可读）"));
                if (found == null) found = f.getAbsolutePath();
            }
        }
        if (found == null) { glog("手机上没找到任何 OpenCL 库"); return ""; }
        try {
            File dir = new File(ctx.getFilesDir(), "cl");
            dir.mkdirs();
            File link = new File(dir, "libOpenCL.so");
            link.delete();
            android.system.Os.symlink(found, link.getAbsolutePath());
            glog("使用 " + found);
            return dir.getAbsolutePath() + ":";
        } catch (Exception e) {
            glog("建立链接失败：" + e.getMessage());
            return "";
        }
    }

    private static class Pending {
        int need;
        JSONArray got = new JSONArray();
        Callback cb;
    }

    public Engine(Context ctx, StatusListener listener) {
        this.ctx = ctx.getApplicationContext();
        this.prefs = ctx.getSharedPreferences("engine", Context.MODE_PRIVATE);
        this.listener = listener;
    }

    public String getStatus() {
        try {
            JSONObject o = new JSONObject();
            o.put("ready", ready);
            o.put("backend", backend);
            o.put("text", status);
            o.put("gpuLog", prefs.getString("gpuLog", ""));
            return o.toString();
        } catch (Exception e) { return "{}"; }
    }

    private void setStatus(String s) {
        status = s;
        Log.i(TAG, s);
        if (listener != null) listener.status(getStatus());
    }

    /** 后台启动。forceCpu=true 时跳过 GPU。 */
    public void start(final boolean forceCpu) {
        new Thread(() -> {
            try {
                copyModels();
                boolean tryGpu = !forceCpu && !prefs.getBoolean("gpuFailed", false)
                        && new File(nativeDir(), "libkatago_cl.so").exists();
                if (tryGpu && launch(true)) return;
                if (tryGpu) prefs.edit().putBoolean("gpuFailed", true).apply();
                if (!launch(false)) setStatus("引擎启动失败，请重启 App 再试");
            } catch (Exception e) {
                Log.e(TAG, "start", e);
                setStatus("引擎启动失败：" + e.getClass().getSimpleName() + " " + e.getMessage());
            }
        }, "engine-start").start();
    }

    public void restart(boolean forceCpu) {
        if (!forceCpu) prefs.edit().putBoolean("gpuFailed", false).apply();
        stop();
        start(forceCpu);
    }

    public void stop() {
        synchronized (lock) {
            generation++;
            ready = false;
            if (proc != null) proc.destroy();
            proc = null;
            for (Pending p : pending.values()) p.cb.done(err("引擎已重启"));
            pending.clear();
        }
    }

    private String nativeDir() { return ctx.getApplicationInfo().nativeLibraryDir; }

    private File modelDir() { return new File(ctx.getFilesDir(), "models"); }

    /** 第一次运行时把模型从安装包复制出来（KataGo 需要真实文件路径）。 */
    private void copyModels() throws Exception {
        File dir = modelDir();
        dir.mkdirs();
        AssetManager am = ctx.getAssets();
        long ver = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0).lastUpdateTime;
        if (prefs.getLong("modelsCopiedFor", 0) == ver) {
            boolean ok = true;
            for (String m : MODELS) if (!new File(dir, m).exists()) ok = false;
            if (ok) return;
        }
        for (String m : MODELS) {
            setStatus("首次启动：正在准备模型 " + m + "…");
            File out = new File(dir, m + ".tmp");
            try (InputStream in = am.open("models/" + m); OutputStream os = new FileOutputStream(out)) {
                byte[] buf = new byte[1 << 16];
                int n;
                while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
            }
            File dst = new File(dir, m);
            if (dst.exists()) dst.delete();
            if (!out.renameTo(dst)) throw new Exception("无法写入模型文件");
        }
        prefs.edit().putLong("modelsCopiedFor", ver).apply();
    }

    private File writeConfig(boolean gpu) throws Exception {
        int cores = Math.max(2, Runtime.getRuntime().availableProcessors());
        File home = new File(ctx.getFilesDir(), "katago");
        home.mkdirs();
        File logs = new File(ctx.getFilesDir(), "logs");
        logs.mkdirs();
        StringBuilder sb = new StringBuilder();
        sb.append("logDir = ").append(logs.getAbsolutePath()).append("\n");
        sb.append("logToStderr = false\n");
        sb.append("homeDataDir = ").append(home.getAbsolutePath()).append("\n");
        sb.append("reportAnalysisWinratesAs = BLACK\n");
        sb.append("maxVisits = 100\n");
        sb.append("numAnalysisThreads = 2\n");
        sb.append("nnCacheSizePowerOfTwo = 20\n");
        sb.append("nnMutexPoolSizePowerOfTwo = 16\n");
        if (gpu) {
            sb.append("numSearchThreadsPerAnalysisThread = 8\n");
            sb.append("nnMaxBatchSize = 16\n");
            sb.append("openclUseFP16 = auto\n");
        } else {
            sb.append("numSearchThreadsPerAnalysisThread = ").append(cores).append("\n");
            sb.append("numEigenThreadsPerModel = ").append(cores).append("\n");
            sb.append("nnMaxBatchSize = 8\n");
        }
        File cfg = new File(ctx.getFilesDir(), gpu ? "analysis_gpu.cfg" : "analysis_cpu.cfg");
        try (OutputStream os = new FileOutputStream(cfg)) {
            os.write(sb.toString().getBytes(StandardCharsets.UTF_8));
        }
        return cfg;
    }

    /** 启动一个后端，等到它说"准备好"为止。成功返回 true。 */
    private boolean launch(final boolean gpu) {
        final int gen;
        final Process p;
        try {
            File bin = new File(nativeDir(), gpu ? "libkatago_cl.so" : "libkatago_eigen.so");
            File cfg = writeConfig(gpu);
            List<String> cmd = new ArrayList<>();
            cmd.add(bin.getAbsolutePath());
            cmd.add("analysis");
            cmd.add("-config"); cmd.add(cfg.getAbsolutePath());
            cmd.add("-model"); cmd.add(new File(modelDir(), "main.txt").getAbsolutePath());
            cmd.add("-human-model"); cmd.add(new File(modelDir(), "human.bin").getAbsolutePath());
            ProcessBuilder pb = new ProcessBuilder(cmd);
            pb.directory(ctx.getFilesDir());
            String extra = "";
            if (gpu) {
                synchronized (gpuLog) { gpuLog.setLength(0); }
                glog("手机：" + android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL + "，安卓 " + android.os.Build.VERSION.RELEASE
                        + "，芯片 " + android.os.Build.HARDWARE);
                extra = prepareOpenCl();
            }
            String libPath = extra + "/vendor/lib64:/system/vendor/lib64:/odm/lib64:/system/lib64:/vendor/lib64/egl:" + nativeDir();
            pb.environment().put("LD_LIBRARY_PATH", libPath);
            pb.environment().put("HOME", ctx.getFilesDir().getAbsolutePath());
            setStatus(gpu ? "正在启动 GPU 引擎…" : "正在启动 CPU 引擎…");
            synchronized (lock) {
                gen = ++generation;
                p = pb.start();
                proc = p;
                stdin = new OutputStreamWriter(p.getOutputStream(), StandardCharsets.UTF_8);
            }
        } catch (Exception e) {
            Log.e(TAG, "launch", e);
            return false;
        }

        final Object readyLock = new Object();
        final boolean[] result = {false, false}; // [decided, ok]

        // stderr：看启动进度（GPU 首次会调优几分钟）
        new Thread(() -> {
            try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getErrorStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) {
                    Log.i(TAG, "stderr: " + line);
                    if (gpu) glog(line);
                    if (line.contains("ready to begin handling requests")) {
                        synchronized (readyLock) { result[0] = true; result[1] = true; readyLock.notifyAll(); }
                    } else if (!ready) {
                        String l = line.trim();
                        if (l.toLowerCase().contains("tun")) setStatus("首次使用 GPU，正在调优（只需一次，约几分钟）…");
                        else if (l.length() > 0 && l.length() < 120) setStatus((gpu ? "GPU" : "CPU") + " 引擎启动中：" + l);
                    }
                }
            } catch (Exception ignored) {}
            synchronized (readyLock) { result[0] = true; readyLock.notifyAll(); }
        }, "engine-stderr").start();

        // stdout：分析结果
        new Thread(() -> readStdout(p, gen), "engine-stdout").start();

        synchronized (readyLock) {
            long deadline = System.currentTimeMillis() + (gpu ? 12 * 60_000L : 5 * 60_000L);
            while (!result[0] && System.currentTimeMillis() < deadline) {
                try { readyLock.wait(1000); } catch (InterruptedException ignored) {}
                if (!p.isAlive()) break;
            }
        }
        if (!result[1] || !p.isAlive()) {
            if (gpu) {
                try { glog("进程退出码：" + (p.isAlive() ? "仍在运行（超时）" : String.valueOf(p.exitValue()))); } catch (Exception ignored) {}
                saveGpuLog("启动失败");
            }
            p.destroy();
            setStatus(gpu ? "GPU 引擎用不了，改用 CPU…" : "CPU 引擎启动失败");
            return false;
        }

        // GPU 能启动不代表能算对：做一次小测试
        if (gpu && !selfTest(gen)) {
            saveGpuLog("自检没通过（结果不对或超时）");
            p.destroy();
            setStatus("GPU 测试没通过，改用 CPU…");
            return false;
        }

        if (gpu) saveGpuLog("GPU 正常");
        backend = gpu ? "GPU" : "CPU";
        List<Runnable> run;
        synchronized (lock) {
            ready = true;
            run = new ArrayList<>(waiting);
            waiting.clear();
        }
        setStatus("引擎就绪（" + backend + "）");
        for (Runnable r : run) r.run();
        return true;
    }

    private void saveGpuLog(String verdict) {
        String t;
        synchronized (gpuLog) { t = "结论：" + verdict + "\n" + gpuLog; }
        prefs.edit().putString("gpuLog", t).apply();
    }

    private boolean selfTest(int gen) {
        final Object o = new Object();
        final String[] res = {null};
        try {
            JSONObject q = new JSONObject();
            q.put("moves", new JSONArray());
            q.put("rules", "chinese");
            q.put("komi", 7);
            q.put("boardXSize", 9);
            q.put("boardYSize", 9);
            q.put("maxVisits", 8);
            q.put("analyzeTurns", new JSONArray().put(0));
            send(q, r -> { synchronized (o) { res[0] = r; o.notifyAll(); } });
            synchronized (o) {
                long end = System.currentTimeMillis() + 120_000;
                while (res[0] == null && System.currentTimeMillis() < end) o.wait(1000);
            }
            if (res[0] == null) return false;
            JSONArray arr = new JSONArray(res[0]);
            if (arr.length() == 0) return false;
            double wr = arr.getJSONObject(0).getJSONObject("rootInfo").getDouble("winrate");
            return !Double.isNaN(wr) && wr > 0.05 && wr < 0.95;
        } catch (Exception e) {
            Log.e(TAG, "selfTest", e);
            return false;
        }
    }

    private void readStdout(Process p, int gen) {
        try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) {
                JSONObject obj;
                try { obj = new JSONObject(line); } catch (Exception e) { continue; }
                String id = obj.optString("id", "");
                Pending pd;
                synchronized (lock) { pd = pending.get(id); }
                if (pd == null) continue;
                if (obj.has("error")) {
                    synchronized (lock) { pending.remove(id); }
                    pd.cb.done(err(obj.optString("error")));
                    continue;
                }
                if (obj.has("warning") && !obj.has("rootInfo")) continue;
                pd.got.put(obj);
                if (pd.got.length() >= pd.need) {
                    synchronized (lock) { pending.remove(id); }
                    pd.cb.done(pd.got.toString());
                }
            }
        } catch (Exception ignored) {}
        // 进程退出：通知所有等待中的请求
        List<Pending> dead = new ArrayList<>();
        synchronized (lock) {
            if (gen == generation) {
                ready = false;
                dead.addAll(pending.values());
                pending.clear();
            }
        }
        for (Pending pd : dead) pd.cb.done(err("引擎意外退出"));
        if (gen == generation && "GPU".equals(backend)) {
            // GPU 运行中崩溃：下次改用 CPU，并立即重启
            prefs.edit().putBoolean("gpuFailed", true).apply();
            backend = "";
            setStatus("GPU 引擎崩溃，改用 CPU 重启…");
            start(true);
        }
    }

    /** 提交一个 KataGo 分析请求（JSON 字符串），结果是 KataGo 原始回复组成的数组。 */
    public void analyze(final String queryJson, final Callback cb) {
        synchronized (lock) {
            if (!ready) {
                waiting.add(() -> analyze(queryJson, cb));
                return;
            }
        }
        try {
            send(new JSONObject(queryJson), cb);
        } catch (Exception e) {
            cb.done(err("请求格式不对：" + e.getMessage()));
        }
    }

    private void send(JSONObject q, Callback cb) throws Exception {
        String id = "q" + ids.getAndIncrement();
        q.put("id", id);
        JSONArray turns = q.optJSONArray("analyzeTurns");
        Pending pd = new Pending();
        pd.need = turns == null ? 1 : Math.max(1, turns.length());
        pd.cb = cb;
        synchronized (lock) {
            pending.put(id, pd);
            if (stdin == null) { pending.remove(id); cb.done(err("引擎未启动")); return; }
            stdin.write(q.toString());
            stdin.write("\n");
            stdin.flush();
        }
    }

    private static String err(String msg) {
        try { return new JSONObject().put("error", msg).toString(); } catch (Exception e) { return "{\"error\":\"?\"}"; }
    }
}
