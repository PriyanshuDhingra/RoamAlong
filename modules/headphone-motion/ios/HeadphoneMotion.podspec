Pod::Spec.new do |s|
  s.name           = 'HeadphoneMotion'
  s.version        = '1.0.0'
  s.summary        = 'AirPods head motion via CMHeadphoneMotionManager'
  s.description    = 'Streams AirPods yaw, pitch and roll to JavaScript.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'CoreMotion'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift}"
end
