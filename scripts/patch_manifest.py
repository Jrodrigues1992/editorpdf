# Faz o APK aparecer na lista "Abrir com" ao tocar em um PDF.
p = 'android/app/src/main/AndroidManifest.xml'
s = open(p, encoding='utf-8').read()
filters = '''
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="content" android:mimeType="application/pdf" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="file" android:mimeType="application/pdf" />
            </intent-filter>
'''
assert '</activity>' in s
s = s.replace('</activity>', filters + '        </activity>', 1)
open(p, 'w', encoding='utf-8').write(s)
print('AndroidManifest atualizado')
