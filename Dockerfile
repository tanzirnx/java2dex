FROM node:20-slim

# ---- Install JDK + tools needed to fetch Android build-tools ----
RUN apt-get update && apt-get install -y --no-install-recommends \
    openjdk-17-jdk-headless \
    wget \
    unzip \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
ENV PATH="${JAVA_HOME}/bin:${PATH}"

# ---- Install Android command-line tools + build-tools (for d8) ----
ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV BUILD_TOOLS_VERSION=34.0.0

RUN mkdir -p ${ANDROID_SDK_ROOT}/cmdline-tools && \
    wget -q https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -O /tmp/cmdline-tools.zip && \
    unzip -q /tmp/cmdline-tools.zip -d ${ANDROID_SDK_ROOT}/cmdline-tools && \
    mv ${ANDROID_SDK_ROOT}/cmdline-tools/cmdline-tools ${ANDROID_SDK_ROOT}/cmdline-tools/latest && \
    rm /tmp/cmdline-tools.zip

ENV PATH="${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin:${PATH}"

ENV PLATFORM_VERSION=android-34

RUN yes | sdkmanager --sdk_root=${ANDROID_SDK_ROOT} --licenses > /dev/null && \
    sdkmanager --sdk_root=${ANDROID_SDK_ROOT} "build-tools;${BUILD_TOOLS_VERSION}" "platforms;${PLATFORM_VERSION}"

ENV PATH="${ANDROID_SDK_ROOT}/build-tools/${BUILD_TOOLS_VERSION}:${PATH}"
ENV D8_PATH="${ANDROID_SDK_ROOT}/build-tools/${BUILD_TOOLS_VERSION}/d8"
ENV ANDROID_JAR="${ANDROID_SDK_ROOT}/platforms/${PLATFORM_VERSION}/android.jar"

# ---- Install jadx (dex/apk/jar -> Java decompiler) ----
ENV JADX_VERSION=1.5.5
RUN mkdir -p /opt/jadx && \
    wget -q "https://github.com/skylot/jadx/releases/download/v${JADX_VERSION}/jadx-${JADX_VERSION}.zip" -O /tmp/jadx.zip && \
    unzip -q /tmp/jadx.zip -d /opt/jadx && \
    chmod +x /opt/jadx/bin/jadx && \
    rm /tmp/jadx.zip

ENV PATH="/opt/jadx/bin:${PATH}"
ENV JADX_PATH="/opt/jadx/bin/jadx"

# ---- smali / baksmali (Java <-> Smali assembler/disassembler) ----
ENV SMALI_VERSION=3.0.9
RUN mkdir -p /opt/smali && \
    wget -q "https://github.com/baksmali/smali/releases/download/${SMALI_VERSION}/baksmali-${SMALI_VERSION}-fat-release.jar" -O /opt/smali/baksmali.jar && \
    wget -q "https://github.com/baksmali/smali/releases/download/${SMALI_VERSION}/smali-${SMALI_VERSION}-fat-release.jar" -O /opt/smali/smali.jar

ENV BAKSMALI_JAR="/opt/smali/baksmali.jar"
ENV SMALI_JAR="/opt/smali/smali.jar"

# ---- AndroidX / Material classes (optional, best-effort) ----
# Extracts classes.jar out of a few common AAR artifacts so code referencing
# androidx.* / com.google.android.material.* can compile too. Each download
# is independent and allowed to fail (`|| true`) — a network hiccup on one
# artifact won't break the whole image build; server.js just uses whatever
# jars actually made it into this directory.
ENV ANDROIDX_LIBS_DIR=/opt/androidx-libs
RUN mkdir -p ${ANDROIDX_LIBS_DIR} /tmp/androidx-fetch && cd /tmp/androidx-fetch && \
    ( wget -q https://maven.google.com/androidx/appcompat/appcompat/1.7.0/appcompat-1.7.0.aar -O appcompat.aar && \
      unzip -p appcompat.aar classes.jar > ${ANDROIDX_LIBS_DIR}/appcompat.jar ) || true && \
    ( wget -q https://maven.google.com/androidx/core/core/1.13.1/core-1.13.1.aar -O core.aar && \
      unzip -p core.aar classes.jar > ${ANDROIDX_LIBS_DIR}/core.jar ) || true && \
    ( wget -q https://maven.google.com/androidx/recyclerview/recyclerview/1.3.2/recyclerview-1.3.2.aar -O recyclerview.aar && \
      unzip -p recyclerview.aar classes.jar > ${ANDROIDX_LIBS_DIR}/recyclerview.jar ) || true && \
    ( wget -q https://maven.google.com/androidx/constraintlayout/constraintlayout/2.1.4/constraintlayout-2.1.4.aar -O constraintlayout.aar && \
      unzip -p constraintlayout.aar classes.jar > ${ANDROIDX_LIBS_DIR}/constraintlayout.jar ) || true && \
    ( wget -q https://maven.google.com/com/google/android/material/material/1.12.0/material-1.12.0.aar -O material.aar && \
      unzip -p material.aar classes.jar > ${ANDROIDX_LIBS_DIR}/material.jar ) || true && \
    ( wget -q https://maven.google.com/androidx/annotation/annotation/1.8.2/annotation-1.8.2.jar -O ${ANDROIDX_LIBS_DIR}/annotation.jar ) || true && \
    cd / && rm -rf /tmp/androidx-fetch && \
    find ${ANDROIDX_LIBS_DIR} -type f -size -1k -delete && \
    echo "AndroidX jars present:" && ls -la ${ANDROIDX_LIBS_DIR} || true

# ---- App setup ----
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
