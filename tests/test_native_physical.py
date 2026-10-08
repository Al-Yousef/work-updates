import importlib.util
import pathlib
import unittest

spec=importlib.util.spec_from_file_location('native_physical',pathlib.Path(__file__).resolve().parent.parent/'native/windows/scripts/physical-qa.py')
driver=importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


class PhysicalContracts(unittest.TestCase):
    def test_worker_rejects_other_owner_busy_restart_and_unprotected_routes(self):
        receipt={'ok':True,'session':'a'*32,'result':{'api_version':4,'owner':{'chat_id':'current'},
            'input_backend':'private_input_v2','protected_input':True,'busy':False}}
        self.assertEqual(driver.worker(receipt,'current'),'a'*32)
        with self.assertRaises(ValueError):driver.worker(receipt,'other')
        with self.assertRaises(ValueError):driver.worker(receipt,'current','b'*32)
        for key,value in [('api_version',3),('input_backend','foreground_messages'),('protected_input',False),('busy',True)]:
            changed={**receipt,'result':{**receipt['result'],key:value}}
            with self.assertRaises(ValueError):driver.worker(changed,'current')

    def test_discovery_requires_exact_owned_pid_root_and_available_window(self):
        owned={'id':'w-owned','pid':123,'root':456,'minimized':False,'assigned_to':None}
        receipt={'ok':True,'result':{'windows':[{'id':'w-other','pid':123,'root':999},owned]}}
        self.assertEqual(driver.owned_window(receipt,123,456),'w-owned')
        with self.assertRaises(ValueError):driver.owned_window(receipt,124,456)
        for changed in [{**owned,'minimized':True},{**owned,'assigned_to':{'chat_id':'other'}}]:
            with self.assertRaises(ValueError):driver.owned_window({'ok':True,'result':{'windows':[changed]}},123,456)
        with self.assertRaises(ValueError):driver.owned_window({'ok':True,'result':{'windows':[owned,owned]}},123,456)


if __name__=='__main__':unittest.main()
